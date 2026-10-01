#!/usr/bin/env node
/*
 * pi-pod-sandbox load-test harness.
 *
 * Runs on the sandbox host inside a throwaway container built from the service image
 * (node 22 + ws), with --network host and --env-file so the master token never appears
 * on a command line or in output.
 *
 *   node lt.mjs stat
 *   node lt.mjs ladder 1,4,8,16,32 --disk 5
 *   node lt.mjs fill --cpu 2 --mem 4 --disk 20
 *   node lt.mjs execlat <id> --n 30
 *   node lt.mjs churn --n 50 --disk 5
 *   node lt.mjs archive <id>
 *   node lt.mjs list | cleanup
 */
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULTS,
  buildResult,
  parseArgs,
  requireOwnerKey,
  requireToken,
  validateResult,
  withLoadtestOwner,
} from "./lib.mjs";

// Origin: hetzner-1 /root/loadtest/lt.mjs (see README.md checksum log). Logic below is
// verbatim except: host-specific absolute paths and endpoints are flags (hetzner-1
// layout as defaults), the token comes ONLY from PI_POD_SANDBOX_TOKEN, --out selects
// the output dir, and every subcommand additionally writes the unified result envelope.
const OPTS = parseArgs(process.argv.slice(2), process.env);

let TOKEN;
let OWNER_KEY;
try {
  TOKEN = requireToken(process.env);
  OWNER_KEY = requireOwnerKey(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const BASE = OPTS.base;
const IMAGE = OPTS.image;
const TAG = OPTS.tag;
const OUT = OPTS.out;

const require = createRequire("/app/");
let WebSocket;
try {
  WebSocket = require("ws");
} catch {
  WebSocket = (await import("ws")).WebSocket;
}

const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };
const STDOUT = 1;

/* ------------------------------------------------------------------ http */

async function api(method, route, body, timeoutMs = 900_000) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(BASE + route, {
      method,
      // A bodyless request must not claim application/json: fastify rejects that with 400.
      headers: body === undefined ? AUTH : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { status: 0, json: { error: { code: "transport", message: String(err?.message ?? err) } }, ms: performance.now() - t0 };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json, ms: performance.now() - t0 };
}

const create = (spec, extra = {}) =>
  api("POST", "/v1/sandboxes", withLoadtestOwner({
    image: IMAGE,
    workdir: "/workspace",
    resources: spec,
    labels: { lt: TAG },
    idleTimeoutMinutes: 0,
    archiveAfterMinutes: 0,
    ...extra,
  }, OWNER_KEY));

const del = (id) => api("DELETE", `/v1/sandboxes/${id}`);
const stop = (id) => api("POST", `/v1/sandboxes/${id}/stop`, {});
const start = (id) => api("POST", `/v1/sandboxes/${id}/start`, {});
const archive = (id) => api("POST", `/v1/sandboxes/${id}/archive`, {});
const health = () => api("GET", "/v1/healthz");
const listOurs = async () => (await api("GET", `/v1/sandboxes?label.lt=${TAG}`)).json?.sandboxes ?? [];

/* -------------------------------------------------------------------- ws */

function exec(id, argv, { timeoutMs = 300_000, capture = 64 * 1024 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let startedMs = null;
    let out = "";
    let errOut = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* already closing */
      }
      resolve({ startedMs, ms: performance.now() - t0, out, err: errOut, ...value });
    };
    const sock = new WebSocket(`${BASE.replace(/^http/, "ws")}/v1/sandboxes/${id}/exec`, { headers: AUTH });
    const timer = setTimeout(() => finish({ error: "harness-timeout" }), timeoutMs);

    sock.on("open", () => sock.send(JSON.stringify({ type: "start", argv, timeoutMs })));
    sock.on("message", (data, isBinary) => {
      if (isBinary) {
        const chunk = data.subarray(1).toString("utf8");
        if (data[0] === STDOUT) {
          if (out.length < capture) out += chunk;
        } else if (errOut.length < capture) errOut += chunk;
        return;
      }
      let frame;
      try {
        frame = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (frame.type === "started") startedMs = performance.now() - t0;
      else if (frame.type === "exit") finish({ exitCode: frame.exitCode });
      else if (frame.type === "error") finish({ error: `${frame.code}: ${frame.message}` });
    });
    sock.on("error", (err) => finish({ error: String(err?.message ?? err) }));
    sock.on("close", () => finish({ error: "closed-without-exit" }));
  });
}

/* ------------------------------------------------------------------ util */

const round = (n) => Math.round(n);

function stats(samples) {
  const xs = samples.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length === 0) return { n: 0 };
  const at = (q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  return {
    n: xs.length,
    min: round(xs[0]),
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p99: round(at(0.99)),
    max: round(xs[xs.length - 1]),
    mean: round(xs.reduce((s, x) => s + x, 0) / xs.length),
  };
}

function save(name, payload) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(payload, null, 2));
}

const RUN_STARTED_AT = new Date().toISOString();

/** Write the unified result envelope for a subcommand (schemaVersion 1, see schema.json). */
function emitResult(subcommand, { samples = [], wallMs = null, errors = [], configExtra = {} } = {}) {
  const finishedAt = new Date().toISOString();
  const result = buildResult({
    host: OPTS.host,
    class: OPTS.class,
    imageDigest: OPTS.imageDigest,
    kernel: OPTS.kernel,
    config: { base: BASE, image: IMAGE, tag: TAG, ...configExtra },
    subcommand,
    samples,
    wallMs: wallMs === null ? null : round(wallMs),
    errors: errors.filter(Boolean).map(String),
    startedAt: RUN_STARTED_AT,
    finishedAt,
  });
  const problems = validateResult(result);
  if (problems.length > 0) console.error(JSON.stringify({ resultSchemaWarnings: problems }));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `result-${subcommand}-${Date.now()}.json`), JSON.stringify(result, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

async function deleteAll(ids, limit = 8) {
  const results = await pool(ids, limit, (id) => del(id));
  const bad = results.filter((r) => r.status !== 200);
  if (bad.length > 0) console.error(JSON.stringify({ deleteFailures: bad.length, sample: bad[0] }));
  return stats(results.filter((r) => r.status === 200).map((r) => r.ms));
}

function summarize(h) {
  const GiB = 1024 ** 3;
  const host = h.json.host;
  return {
    sandboxes: h.json.sandboxes,
    committedCpu: host.committed.cpu,
    committedMemGiB: +(host.committed.memoryBytes / GiB).toFixed(2),
    committedDiskGiB: +(host.committed.diskBytes / GiB).toFixed(1),
    capacityCpu: host.guaranteeCapacity.cpu,
    capacityMemGiB: +(host.guaranteeCapacity.memoryBytes / GiB).toFixed(1),
    diskCapacityGiB: +(host.diskCapacityBytes / GiB).toFixed(1),
    memAvailableGiB: +(host.memoryAvailableBytes / GiB).toFixed(1),
  };
}

/* -------------------------------------------------------------- commands */

const argv = process.argv.slice(2);
const cmd = argv[0];
// Positionals are everything that is neither a `--flag` nor the value consumed by one.
const positional = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--") break;
  if (argv[i].startsWith("--")) i++;
  else positional.push(argv[i]);
}
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}
const num = (name, fallback) => Number(flag(name, fallback));

function specFromFlags() {
  const spec = {};
  if (flag("cpu") !== undefined) spec.cpu = num("cpu");
  if (flag("mem") !== undefined) spec.memoryGB = num("mem");
  if (flag("disk") !== undefined) spec.diskGB = num("disk");
  return spec;
}

async function cmdStat() {
  const h = await health();
  console.log(JSON.stringify(summarize(h)));
  emitResult("stat", {});
}

/** create→running latency at each concurrency level; deletes what it created. */
async function cmdLadder() {
  const levels = (positional[0] ?? "1,4,8,16,32").split(",").map(Number);
  const spec = specFromFlags();
  const report = [];
  for (const level of levels) {
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: level }, () => create(spec)));
    const wallMs = performance.now() - t0;
    const ok = results.filter((r) => r.status === 200);
    const denied = results.filter((r) => r.status === 507);
    const other = results.filter((r) => r.status !== 200 && r.status !== 507);
    const row = {
      concurrency: level,
      admitted: ok.length,
      denied507: denied.length,
      otherErrors: other.length,
      wallMs: round(wallMs),
      latencyMs: stats(ok.map((r) => r.ms)),
      firstDenial: denied[0]?.json?.error?.message ?? null,
      otherSample: other[0]?.json?.error?.message ?? null,
      samples: ok.map((r) => round(r.ms)),
    };
    report.push(row);
    console.log(JSON.stringify({ ...row, samples: undefined }));
    await deleteAll(ok.map((r) => r.json.id));
    await sleep(2000);
  }
  save(`ladder-${Date.now()}`, report);
  emitResult("ladder", {
    samples: report.flatMap((row) => row.samples ?? []),
    wallMs: report.reduce((s, row) => s + row.wallMs, 0),
    errors: report.filter((row) => row.otherErrors > 0).map((row) => `c=${row.concurrency}: ${row.otherSample}`),
    configExtra: { spec, levels: levels.join(",") },
  });
}

/** create at fixed caps until admission control refuses; leaves the fleet standing. */
async function cmdFill() {
  const spec = specFromFlags();
  const limit = num("max", 64);
  const latencies = [];
  const ids = [];
  let denial = null;
  for (let i = 0; i < limit; i++) {
    const r = await create(spec);
    if (r.status === 200) {
      ids.push(r.json.id);
      latencies.push(r.ms);
      if (num("progress", 1)) console.log(JSON.stringify({ i: ids.length, ms: round(r.ms) }));
      continue;
    }
    denial = { status: r.status, message: r.json?.error?.message ?? null, ms: round(r.ms) };
    break;
  }
  const h = await health();
  const payload = {
    spec,
    admitted: ids.length,
    denial,
    latencyMs: stats(latencies),
    perLaunchMs: latencies.map(round),
    health: summarize(h),
    ids,
  };
  save(`fill-${Date.now()}`, payload);
  console.log(JSON.stringify({ ...payload, ids: undefined, perLaunchMs: undefined }));
  emitResult("fill", {
    samples: latencies,
    errors: denial && denial.message ? [denial.message] : [],
    configExtra: { spec },
  });
}

async function cmdExec() {
  const id = positional[0];
  const dashdash = argv.indexOf("--");
  const command = dashdash === -1 ? ["true"] : argv.slice(dashdash + 1);
  const r = await exec(id, command, { timeoutMs: num("timeout", 300000) });
  console.log(JSON.stringify({ exitCode: r.exitCode, error: r.error, ms: round(r.ms), startedMs: round(r.startedMs ?? -1) }));
  if (r.out) console.log(r.out.trimEnd());
  if (r.err) console.error(r.err.trimEnd());
  emitResult("exec", { samples: Number.isFinite(r.ms) ? [r.ms] : [], errors: r.error ? [r.error] : [] });
}

/** exec round-trip distribution against one or all of our sandboxes. */
async function cmdExecLat() {
  const n = num("n", 30);
  const ids = positional.length > 0 ? positional : (await listOurs()).filter((s) => s.state === "started").map((s) => s.id);
  if (ids.length === 0) {
    console.log(JSON.stringify({ error: "no started sandboxes" }));
    emitResult("execlat", { errors: ["no started sandboxes"], configExtra: { n } });
    return;
  }
  const round1 = [];
  const started = [];
  for (let i = 0; i < n; i++) {
    const r = await exec(ids[i % ids.length], ["/bin/true"], { timeoutMs: 60_000 });
    if (r.exitCode === 0) {
      round1.push(r.ms);
      started.push(r.startedMs);
    }
  }
  const payload = { n, sandboxes: ids.length, execMs: stats(round1), timeToStartedMs: stats(started) };
  save(`execlat-${Date.now()}`, payload);
  console.log(JSON.stringify(payload));
  emitResult("execlat", { samples: round1, configExtra: { n, sandboxes: ids.length } });
}

/** create → exec → stop → delete, N times; the leak check reads the host outside. */
async function cmdChurn() {
  const n = num("n", 50);
  const spec = specFromFlags();
  const createMs = [];
  const execMs = [];
  const stopMs = [];
  const deleteMs = [];
  let failures = 0;
  for (let i = 0; i < n; i++) {
    const c = await create(spec);
    if (c.status !== 200) {
      failures++;
      console.log(JSON.stringify({ i, status: c.status, message: c.json?.error?.message }));
      continue;
    }
    createMs.push(c.ms);
    const id = c.json.id;
    const e = await exec(id, ["/bin/true"], { timeoutMs: 60_000 });
    if (e.exitCode === 0) execMs.push(e.ms);
    else failures++;
    const s = await stop(id);
    if (s.status === 200) stopMs.push(s.ms);
    else failures++;
    const d = await del(id);
    if (d.status === 200) deleteMs.push(d.ms);
    else failures++;
    if (i % 10 === 0) console.log(JSON.stringify({ cycle: i, createMs: round(c.ms) }));
  }
  const payload = {
    cycles: n,
    failures,
    createMs: stats(createMs),
    execMs: stats(execMs),
    stopMs: stats(stopMs),
    deleteMs: stats(deleteMs),
    health: summarize(await health()),
  };
  save(`churn-${Date.now()}`, payload);
  console.log(JSON.stringify(payload));
  emitResult("churn", {
    samples: createMs,
    errors: failures > 0 ? [`${failures} cycle failures`] : [],
    configExtra: { spec, cycles: n, stopMs: stats(stopMs), deleteMs: stats(deleteMs), execMs: stats(execMs) },
  });
}

/** stop→archive→(restore) round trip; restore proves the object landed in the bucket. */
async function cmdArchive() {
  const id = positional[0];
  const a = await archive(id);
  const info = a.json ?? {};
  const restore = flag("restore", "1") === "1" ? await start(id) : null;
  const payload = {
    id,
    archiveStatus: a.status,
    archiveMs: round(a.ms),
    archiveKeyPresent: Boolean(info.archiveKey),
    archiveSizeBytes: info.archiveSize ?? null,
    state: info.state ?? null,
    restoreStatus: restore?.status ?? null,
    restoreMs: restore ? round(restore.ms) : null,
    restoreState: restore?.json?.state ?? null,
    restoreError: restore && restore.status !== 200 ? restore.json?.error?.message : null,
  };
  save(`archive-${id}-${Date.now()}`, payload);
  console.log(JSON.stringify(payload));
  emitResult("archive", {
    samples: [a.ms],
    errors: payload.restoreError ? [payload.restoreError] : [],
    configExtra: { id },
  });
}

/** N parallel archives while the host is full. */
async function cmdArchiveAll() {
  const ids = positional.length > 0 ? positional : (await listOurs()).map((s) => s.id);
  const t0 = performance.now();
  const results = await Promise.all(ids.map((id) => archive(id)));
  const payload = {
    count: ids.length,
    wallMs: round(performance.now() - t0),
    ok: results.filter((r) => r.status === 200).length,
    archiveMs: stats(results.filter((r) => r.status === 200).map((r) => r.ms)),
    bytes: results.filter((r) => r.status === 200).map((r) => r.json.archiveSize ?? 0),
    errors: results.filter((r) => r.status !== 200).map((r) => r.json?.error?.message),
  };
  save(`archiveall-${Date.now()}`, payload);
  console.log(JSON.stringify(payload));
  emitResult("archiveall", {
    samples: results.filter((r) => r.status === 200).map((r) => r.ms),
    wallMs: payload.wallMs,
    errors: payload.errors,
  });
}

/** Pin every live sandbox to its CPU ceiling, then measure the host from inside the load. */
async function cmdSaturate() {
  const seconds = num("seconds", 40);
  const spinners = num("spinners", 8);
  const ids = (await listOurs()).filter((s) => s.state === "started").map((s) => s.id);
  const burner = `for i in $(seq ${spinners}); do timeout ${seconds} sh -c 'while :; do :; done' & done; wait`;
  const load = ids.map((id) => exec(id, ["/bin/sh", "-c", burner], { timeoutMs: (seconds + 30) * 1000 }));
  await sleep(5_000);

  const execMs = [];
  const startedMs = [];
  const deadline = Date.now() + (seconds - 15) * 1000;
  for (let i = 0; Date.now() < deadline; i++) {
    const r = await exec(ids[i % ids.length], ["/bin/true"], { timeoutMs: 60_000 });
    if (r.exitCode === 0) {
      execMs.push(r.ms);
      startedMs.push(r.startedMs);
    }
  }
  const launch = await create({ cpu: 2, memoryGB: 4, diskGB: 1 });
  const launchMs = launch.status === 200 ? round(launch.ms) : null;
  const hDuringLoad = summarize(await health());
  if (launch.status === 200) await del(launch.json.id);

  const done = await Promise.all(load);
  const payload = {
    sandboxes: ids.length,
    spinnersEach: spinners,
    seconds,
    execMsUnderLoad: stats(execMs),
    timeToStartedMsUnderLoad: stats(startedMs),
    launchMsUnderLoad: launchMs,
    launchStatus: launch.status,
    healthDuringLoad: hDuringLoad,
    burnerExits: done.map((d) => d.exitCode ?? d.error),
  };
  save(`saturate-${Date.now()}`, payload);
  console.log(JSON.stringify(payload));
  emitResult("saturate", {
    samples: execMs,
    errors: launch.status === 200 ? [] : [`launch under load: ${launch.status}`],
    configExtra: { seconds, spinnersEach: spinners, sandboxes: ids.length },
  });
}

/** Same command in every live sandbox at once; reports exit codes, not output. */
async function cmdRunAll() {
  const dashdash = argv.indexOf("--");
  const command = argv.slice(dashdash + 1);
  const ids = (await listOurs()).filter((s) => s.state === "started").map((s) => s.id);
  const t0 = performance.now();
  const results = await Promise.all(ids.map((id) => exec(id, command, { timeoutMs: num("timeout", 300000) })));
  const payload = {
    sandboxes: ids.length,
    wallMs: round(performance.now() - t0),
    exits: results.map((r) => r.exitCode ?? r.error),
    oomKilled: results.filter((r) => r.exitCode === 137).length,
    ok: results.filter((r) => r.exitCode === 0).length,
    durationMs: stats(results.map((r) => r.ms)),
    lastStdout: results.map((r) => r.out.trim().split("\n").pop() ?? ""),
  };
  save(`runall-${Date.now()}`, payload);
  console.log(JSON.stringify(payload));
  emitResult("runall", { samples: results.map((r) => r.ms), wallMs: payload.wallMs });
}

/* Independent ListObjectsV2 against the archive bucket: proves an archive really landed in
 * DO Spaces rather than trusting the service's own report. Credentials come from the env file
 * and are only ever used to sign; nothing about them is printed. */
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function signedListUrl() {
  const endpoint = process.env.PI_POD_SANDBOX_S3_ENDPOINT ?? `https://${process.env.PI_POD_SANDBOX_S3_REGION}.digitaloceanspaces.com`;
  const url = new URL(endpoint);
  url.pathname = `/${process.env.PI_POD_SANDBOX_S3_BUCKET}`;
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", `${(process.env.PI_POD_SANDBOX_S3_PREFIX ?? "sandboxes").replace(/\/+$/, "")}/`);
  url.searchParams.set("max-keys", "1000");
  return url;
}

async function s3List() {
  const url = signedListUrl();
  const region = process.env.PI_POD_SANDBOX_S3_REGION ?? "us-east-1";
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers = { host: url.host, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": amzDate };
  const signedNames = Object.keys(headers).sort();
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    "GET",
    url.pathname,
    canonicalQuery,
    signedNames.map((n) => `${n}:${headers[n]}\n`).join(""),
    signedNames.join(";"),
    EMPTY_SHA256,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
  const signing = ["aws4_request"].reduce(
    (k, part) => hmac(k, part),
    hmac(hmac(hmac(`AWS4${process.env.PI_POD_SANDBOX_S3_SECRET_KEY}`, day), region), "s3"),
  );
  const signature = createHmac("sha256", signing).update(toSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${process.env.PI_POD_SANDBOX_S3_ACCESS_KEY}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
  const res = await fetch(url, { headers: { ...headers, authorization } });
  const xml = await res.text();
  if (!res.ok) return { status: res.status, objects: [] };
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, body]) => ({
    key: /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1] ?? "",
    size: Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0),
  }));
  return { status: res.status, objects };
}

async function cmdS3Ls() {
  const { status, objects } = await s3List();
  const workspaces = objects.filter((o) => /upper-[0-9a-f]{64}\.tar\.zst$/.test(o.key));
  const payload = {
    status,
    totalObjects: objects.length,
    workspaceArchives: workspaces.length,
    totalBytes: workspaces.reduce((s, o) => s + o.size, 0),
    sizes: workspaces.map((o) => o.size),
    sample: workspaces[0]?.key ?? null,
  };
  save(`s3ls-${Date.now()}`, payload);
  console.log(JSON.stringify(payload));
  emitResult("s3ls", { samples: workspaces.map((o) => o.size), configExtra: { unit: "bytes" } });
}

/** Start every archived sandbox at once: download from Spaces + sha256 + unpack + launch. */
async function cmdRestoreAll() {
  const rows = (await listOurs()).filter((s) => s.state === "archived");
  const listed = await s3List();
  const keyed = new Set(listed.objects.map((o) => o.key.split("/")[1]));
  const t0 = performance.now();
  const results = await Promise.all(rows.map((s) => start(s.id)));
  const payload = {
    archived: rows.length,
    inBucket: rows.filter((s) => keyed.has(s.id)).length,
    wallMs: round(performance.now() - t0),
    ok: results.filter((r) => r.status === 200).length,
    restoreMs: stats(results.filter((r) => r.status === 200).map((r) => r.ms)),
    errors: results.filter((r) => r.status !== 200).map((r) => r.json?.error?.message).slice(0, 3),
  };
  save(`restoreall-${Date.now()}`, payload);
  console.log(JSON.stringify(payload));
  emitResult("restoreall", {
    samples: results.filter((r) => r.status === 200).map((r) => r.ms),
    wallMs: payload.wallMs,
    errors: payload.errors,
    configExtra: { archived: rows.length },
  });
}

async function cmdList() {
  const rows = await listOurs();
  console.log(JSON.stringify(rows.map((s) => ({ id: s.id, state: s.state, ceiling: s.ceiling }))));
  emitResult("list", {});
}

async function cmdCleanup() {
  const rows = await listOurs();
  await deleteAll(rows.map((s) => s.id));
  console.log(JSON.stringify({ deleted: rows.length, health: summarize(await health()) }));
  emitResult("cleanup", {});
}

const COMMANDS = {
  stat: cmdStat,
  ladder: cmdLadder,
  fill: cmdFill,
  exec: cmdExec,
  execlat: cmdExecLat,
  churn: cmdChurn,
  saturate: cmdSaturate,
  runall: cmdRunAll,
  s3ls: cmdS3Ls,
  restoreall: cmdRestoreAll,
  archive: cmdArchive,
  archiveall: cmdArchiveAll,
  list: cmdList,
  cleanup: cmdCleanup,
};

const handler = COMMANDS[cmd];
if (!handler) {
  console.error(`usage: lt.mjs <${Object.keys(COMMANDS).join("|")}> [args]`);
  console.error("flags: --base --image --tag --out <dir> (default ./out) --host --class --image-digest --kernel");
  console.error("       --env-file --lt-dir --service --cgroup-root --state-dir (host paths, hetzner-1 defaults)");
  console.error("token ONLY from PI_POD_SANDBOX_TOKEN env (via lt.sh --env-file); host/kernel/digest from flags or defaults, never SSH");
  process.exit(2);
}
await handler();
process.exit(0);
