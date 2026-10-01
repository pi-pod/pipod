/**
 * A scripted `op` binary for secret-ref tests. Resolves JSON templates on stdin
 * from FAKE_OP_MAP and records the child environment when asked.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const FAKE_OP_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
if (process.env.FAKE_OP_ENV_OUT) {
  fs.writeFileSync(
    process.env.FAKE_OP_ENV_OUT,
    JSON.stringify({
      token: process.env.OP_SERVICE_ACCOUNT_TOKEN ?? null,
      connectHost: process.env.OP_CONNECT_HOST ?? null,
      connectToken: process.env.OP_CONNECT_TOKEN ?? null,
    }),
  );
}

if (args[0] === "--version") {
  process.stdout.write("2.0.0\\n");
  process.exit(0);
}

if (process.env.FAKE_OP_FAIL) {
  process.stderr.write(process.env.FAKE_OP_FAIL + "\\n");
  process.exit(Number(process.env.FAKE_OP_EXIT || 1));
}

const map = JSON.parse(process.env.FAKE_OP_MAP || "{}");
const omit = new Set((process.env.FAKE_OP_OMIT || "").split(",").filter(Boolean));

if (args[0] === "read") {
  const ref = args[1];
  if (typeof ref !== "string" || !(ref in map)) {
    process.stderr.write("could not read " + ref + "\\n");
    process.exit(1);
  }
  process.stdout.write(map[ref] + "\\n");
  process.exit(0);
}

if (args[0] !== "inject") {
  process.stderr.write("unknown op command: " + args.join(" ") + "\\n");
  process.exit(2);
}

const inFileIdx = args.indexOf("--in-file");
const input = inFileIdx >= 0 ? fs.readFileSync(args[inFileIdx + 1], "utf8") : fs.readFileSync(0, "utf8");
let parsed;
try {
  parsed = JSON.parse(input);
} catch {
  process.stderr.write("fake op: stdin is not JSON\\n");
  process.exit(1);
}

const out = {};
for (const [key, value] of Object.entries(parsed)) {
  if (omit.has(key)) continue;
  if (typeof value === "string" && value.startsWith("op://")) {
    if (process.env.FAKE_OP_UNREPLACED) {
      out[key] = value;
      continue;
    }
    if (!(value in map)) {
      process.stderr.write("could not resolve " + value + "\\n");
      process.exit(1);
    }
    out[key] = map[value];
  } else {
    out[key] = value;
  }
}
process.stdout.write(JSON.stringify(out));
`;

export function writeFakeOp(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "op");
  fs.writeFileSync(file, FAKE_OP_SOURCE, { mode: 0o755 });
  return file;
}

export function writeTokenCommand(dir: string, token: string, name = "token"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(token)} + "\\n");\n`, {
    mode: 0o755,
  });
  return file;
}
