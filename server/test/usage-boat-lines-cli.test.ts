/**
 * Real CLI: `usage-ledger boat-lines` parses JSON before import. No database.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src/server/usage/cli.ts");

function run(payload: string): { status: number | null; stderr: string; stdout: string; out?: unknown } {
  const dir = mkdtempSync(join(tmpdir(), "boat-lines-"));
  const inn = join(dir, "in.json");
  const out = join(dir, "out.json");
  writeFileSync(inn, payload);
  const proc = spawnSync(process.execPath, ["--import", "tsx", cli, "boat-lines", inn, "--out", out], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "" },
    cwd: root,
    timeout: 20_000,
  });
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(out, "utf8")); } catch { parsed = undefined; }
  return { status: proc.status, stderr: proc.stderr, stdout: proc.stdout, out: parsed };
}

test("boat-lines CLI refuses malformed allocateFrom and cents", () => {
  assert.notEqual(run("[]").status, 0);
  assert.match(run("[]").stderr, /JSON object/);
  assert.notEqual(run(JSON.stringify({ periodStart: "2026-09-01", periodEnd: "2026-10-01", allocateFrom: "nope" })).status, 0);
  assert.match(run(JSON.stringify({ periodStart: "2026-09-01", periodEnd: "2026-10-01", allocateFrom: "nope" })).stderr, /allocateFrom/);
  assert.notEqual(run(JSON.stringify({ periodStart: "2026-09-01", periodEnd: "2026-10-01", allocateFrom: 1 })).status, 0);
  assert.notEqual(run(JSON.stringify({ periodStart: "2026-09-01", periodEnd: "2026-10-01", creditConsumptionCents: 1.5 })).status, 0);
  assert.match(run(JSON.stringify({ periodStart: "2026-09-01", periodEnd: "2026-10-01", creditConsumptionCents: 1.5 })).stderr, /safe integer/);
});

test("boat-lines CLI writes one consumption layer for valid JSON", () => {
  const result = run(JSON.stringify({
    periodStart: "2026-09-01", periodEnd: "2026-10-01",
    creditConsumptionCents: 1151, subscriptionBaselineCents: 2000, label: "cli-fix",
  }));
  assert.equal(result.status, 0);
  assert.equal(Array.isArray(result.out), true);
  const lines = result.out as Array<{ amountMinor: number; lineLabel: string }>;
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.amountMinor, 1151);
  assert.match(lines[0]!.lineLabel, /boat-layer/);
});
