#!/usr/bin/env node
/**
 * Manual-testing client for the service's wire API — the same HTTP/WS calls the
 * pi-pod-server adapter makes, driven by hand.
 *
 *   ppsctl.mjs exec <id> <argv...>
 *   ppsctl.mjs pty <id> [sessionId]      interactive; Ctrl-] detaches, Ctrl-\ kills
 *   ppsctl.mjs put <id> <local> <remote> [mode]
 *   ppsctl.mjs get <id> <remote> [local]
 *   ppsctl.mjs <method> <path> [json-body]
 */
import * as fs from "node:fs";
import { WebSocket } from "ws";

const BASE = process.env.PPS_URL ?? "http://localhost:8433";
const TOKEN = process.env.PI_POD_SANDBOX_TOKEN ?? "dev-token-0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}` };
const wsBase = BASE.replace(/^http/, "ws");

const [cmd, ...rest] = process.argv.slice(2);

async function rest_(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  console.log(`${res.status} ${text}`);
  if (!res.ok) process.exitCode = 1;
}

function openWs(path) {
  return new WebSocket(`${wsBase}${path}`, { headers: auth });
}

if (cmd === "exec") {
  const [id, ...argv] = rest;
  const ws = openWs(`/v1/sandboxes/${id}/exec`);
  ws.on("open", () => ws.send(JSON.stringify({ type: "start", argv })));
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const stream = data[0];
      (stream === 2 ? process.stderr : process.stdout).write(data.subarray(1));
      return;
    }
    const frame = JSON.parse(data.toString());
    if (frame.type === "exit") {
      process.exitCode = frame.exitCode;
      console.error(`[exit ${frame.exitCode}]`);
    } else if (frame.type === "error") {
      console.error(`[error ${frame.code}: ${frame.message}]`);
      process.exitCode = 1;
    }
  });
  ws.on("close", () => process.exit(process.exitCode ?? 0));
} else if (cmd === "pty") {
  const [id, sessionId] = rest;
  const ws = openWs(`/v1/sandboxes/${id}/pty`);
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  ws.on("open", () =>
    ws.send(
      JSON.stringify(
        sessionId
          ? { type: "attach", sessionId, cols, rows }
          : { type: "open", argv: ["/bin/sh", "-i"], cols, rows },
      ),
    ),
  );
  ws.on("message", (data, isBinary) => {
    if (isBinary) return void process.stdout.write(data);
    const frame = JSON.parse(data.toString());
    if (frame.type === "ready") console.error(`[session ${frame.sessionId} reattached=${frame.reattached}]`);
    else if (frame.type === "exit") console.error(`[exit ${frame.exitCode}]`);
    else console.error(`[${frame.type} ${frame.code}: ${frame.message}]`);
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", (chunk) => {
    if (chunk[0] === 0x1d) return void ws.send(JSON.stringify({ type: "detach" }));
    if (chunk[0] === 0x1c) return void ws.send(JSON.stringify({ type: "kill" }));
    ws.send(chunk, { binary: true });
  });
  process.stdout.on("resize", () =>
    ws.send(JSON.stringify({ type: "resize", cols: process.stdout.columns, rows: process.stdout.rows })),
  );
  ws.on("close", () => process.exit(0));
} else if (cmd === "put") {
  const [id, local, remote, mode = "644"] = rest;
  const res = await fetch(
    `${BASE}/v1/sandboxes/${id}/files?path=${encodeURIComponent(remote)}&mode=${mode}`,
    {
      method: "PUT",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: fs.createReadStream(local),
      duplex: "half",
    },
  );
  console.log(res.status, await res.text());
} else if (cmd === "get") {
  const [id, remote, local] = rest;
  const res = await fetch(`${BASE}/v1/sandboxes/${id}/files?path=${encodeURIComponent(remote)}`, {
    headers: auth,
  });
  if (!res.ok) {
    console.error(res.status, await res.text());
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (local) fs.writeFileSync(local, buf);
  else process.stdout.write(buf);
} else {
  const [path, body] = rest;
  await rest_(cmd.toUpperCase(), path, body ? JSON.parse(body) : undefined);
}
