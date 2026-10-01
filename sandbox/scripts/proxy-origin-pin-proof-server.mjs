#!/usr/bin/env node
// Synthetic two-origin proof server (test harness only, no real secrets).
// Implements the production proxy wire protocol for one hostId + synthetic token,
// counts only /v1/host-archives hits as production egress. GET /__counts is
// harness-only and is never counted.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const HOST = process.env.PROOF_HOST ?? "boat-proofhost";
const TOKEN = process.env.PROOF_TOKEN ?? "synthetic-proof-token-0123456789abcdef";
const objects = new Map();
let hits = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  if (url.pathname === "/__counts") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hits }));
    return;
  }
  const match = /^\/v1\/host-archives\/([^/]+)\/objects(\/(.*))?$/.exec(url.pathname);
  if (!match) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no");
    return;
  }
  hits += 1;
  const fail = (code, body = "no") => {
    res.writeHead(code, { "content-type": "text/plain" });
    res.end(body);
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return fail(401);
  const pathHost = decodeURIComponent(match[1]);
  if (pathHost !== HOST) return fail(403);
  if (req.method === "GET" && match[3] === undefined) {
    const prefix = url.searchParams.get("prefix") ?? "";
    const scoped = `${pathHost}/${prefix}`;
    const listed = [...objects.entries()]
      .filter(([k]) => k.startsWith(scoped))
      .map(([k, bytes]) => ({ key: k.slice(pathHost.length + 1), size: bytes.length, lastModified: 1700000000000 }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ objects: listed }));
    return;
  }
  const key = (match[3] ?? "").split("/").map(decodeURIComponent).join("/");
  const namespaced = `${pathHost}/${key}`;
  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const actual = createHash("sha256").update(bytes).digest("hex");
      const claimed = req.headers["x-pipod-sha256"];
      if (typeof claimed === "string" && claimed !== actual) return fail(400, "checksum mismatch");
      objects.set(namespaced, bytes);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ key, size: bytes.length, sha256: actual }));
    });
    return;
  }
  if (req.method === "GET") {
    const bytes = objects.get(namespaced);
    if (!bytes) return fail(404);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
    res.end(bytes);
    return;
  }
  if (req.method === "HEAD") {
    const bytes = objects.get(namespaced);
    if (!bytes) return fail(404);
    const sha = createHash("sha256").update(bytes).digest("hex");
    res.writeHead(200, { "x-pipod-size": String(bytes.length), "x-pipod-sha256": sha });
    res.end();
    return;
  }
  if (req.method === "DELETE") {
    if (!objects.delete(namespaced)) return fail(404);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  return fail(405);
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  // Single READY line for the parent to parse; nothing else on stdout.
  process.stdout.write(`READY ${JSON.stringify({ port, pid: process.pid })}\n`);
});
