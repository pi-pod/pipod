#!/usr/bin/env node
// Operator producer for the archive proxy origin binding (GAP-1).
//
// Writes <stateDir>/archive-proxy-binding.json atomically:
// exclusive 0600 temp fd -> write -> fsync -> close -> rename ->
// parent-dir fsync -> bounded read-back that must parse to exactly the
// intended {version,hostId,origin}. Never mints from ambient env: host and
// origin come only from explicit argv. Takes and prints no credentials.
//
// Usage:
//   node scripts/write-proxy-origin-binding.mjs \
//     --state-dir <dir> --host-id <boat-id> --origin <bare-origin>
//
// Existing static+proxy operators MUST run this (with the verified host and
// origin) BEFORE updating to a pinned runtime, or proxy activation will fail
// closed with archive_proxy_origin_missing. local/S3/none are unaffected.
import { closeSync, fsyncSync, lstatSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } from "node:constants";
import * as path from "node:path";

const VERSION = 1;
const FILENAME = "archive-proxy-binding.json";
const MAX_BYTES = 8192;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function fail(message) {
  process.stderr.write(`write-proxy-origin-binding: ${message}\n`);
  process.exit(1);
}

// Strict bare-origin mirror of canonicalizeProxyOrigin (runtime): raw rejects
// before URL parse so /../, /%2e%2e/, trailing paths, ? and # never normalize.
function canonicalize(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) fail("origin must be a 1-2048 char string");
  if (/[\u0000-\u0020\u007f]/.test(raw)) fail("origin must not contain whitespace/control characters");
  if (raw.includes("?") || raw.includes("#")) fail("origin must have no query/fragment");
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd <= 0) fail("origin must be a bare scheme://host[:port]");
  const after = raw.slice(schemeEnd + 3);
  const slashAt = after.indexOf("/");
  const authority = slashAt === -1 ? after : after.slice(0, slashAt);
  const rest = slashAt === -1 ? "" : after.slice(slashAt);
  if (authority === "" || authority.includes("@")) fail("origin must have no userinfo");
  if (rest !== "" && rest !== "/") fail("origin must have no path");
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("origin is not a valid URL");
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") fail("origin must be https (http loopback-test only)");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") fail("origin must be bare");
  if (url.pathname !== "" && url.pathname !== "/") fail("origin must be bare");
  const host = url.hostname.toLowerCase();
  if (host === "") fail("origin needs a host");
  if (protocol === "http:" && !LOOPBACK.has(host)) fail("http origins are loopback-test only");
  const part = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${protocol}//${part}${url.port === "" ? "" : `:${url.port}`}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/write-proxy-origin-binding.mjs --state-dir <dir> --host-id <id> --origin <bare-origin>\n",
      );
      process.exit(0);
    }
    if (arg === "--state-dir" || arg === "--host-id" || arg === "--origin") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} needs a value`);
      out[arg.slice(2)] = value;
      i++;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!out["state-dir"] || !out["host-id"] || !out["origin"]) fail("need --state-dir, --host-id and --origin");
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!HOST_PATTERN.test(args["host-id"])) fail("host-id must be a bare object-key-safe name");
const origin = canonicalize(args.origin);
const dir = path.resolve(args["state-dir"]);
try {
  mkdirSync(dir, { recursive: true });
} catch (error) {
  fail(`cannot create state dir: ${error.code ?? error.message}`);
}
const target = path.join(dir, FILENAME);
const payload = `${JSON.stringify({ version: VERSION, hostId: args["host-id"], origin }, null, 2)}\n`;
const temporary = path.join(dir, `.${FILENAME}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
let fd = -1;
try {
  // O_CREAT|O_EXCL|O_NOFOLLOW: never follow or clobber; 0600 at creation.
  fd = openSync(temporary, O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY, 0o600);
} catch (error) {
  fail(`cannot create temp binding: ${error.code ?? error.message}`);
}
try {
  writeSync(fd, payload, null, "utf8");
  fsyncSync(fd);
} finally {
  try {
    closeSync(fd);
  } catch {
    // ignore
  }
}
try {
  renameSync(temporary, target);
} catch (error) {
  fail(`cannot install binding: ${error.code ?? error.message}`);
}
const dirFd = openSync(dir, O_RDONLY);
try {
  fsyncSync(dirFd);
} finally {
  closeSync(dirFd);
}
// Bounded read-back: must parse to exactly what was intended.
let st;
try {
  st = lstatSync(target);
} catch {
  fail("binding missing after install");
}
if (!st.isFile() || st.size > MAX_BYTES || st.size <= 0) fail("binding failed verification");
const rfd = openSync(target, O_RDONLY | O_NOFOLLOW);
let parsed;
try {
  const buf = Buffer.alloc(st.size);
  let off = 0;
  while (off < st.size) {
    const n = readSync(rfd, buf, off, st.size - off, null);
    if (n <= 0) break;
    off += n;
  }
  if (off !== st.size) fail("binding failed verification");
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    fail("binding failed verification");
  }
} finally {
  closeSync(rfd);
}
if (
  typeof parsed !== "object" ||
  parsed === null ||
  parsed.version !== VERSION ||
  parsed.hostId !== args["host-id"] ||
  parsed.origin !== origin
) {
  fail("binding failed verification");
}
// Only safe fields on stdout: version, host, origin, path. No credentials exist.
process.stdout.write(`${JSON.stringify({ path: target, version: VERSION, hostId: args["host-id"], origin })}\n`);
