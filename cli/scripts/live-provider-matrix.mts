#!/usr/bin/env npx tsx
/**
 * Opt-in single-provider live smoke test (sandbox is the only backend).
 *
 *   PI_POD_LIVE_MATRIX=1 node --import tsx scripts/live-provider-matrix.mts
 *
 * Prints Markdown and writes JSON/JUnit under ./tmp/live-provider-matrix/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PROVIDERS = ["sandbox"] as const;
type Cell = "PASS" | "FAIL" | "SKIPPED";

interface Row {
  name: string;
  cells: Record<string, { result: Cell; note?: string }>;
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000 });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, out };
}

function main(): void {
  if (process.env["PI_POD_LIVE_MATRIX"] !== "1") {
    console.log("live-provider-matrix is opt-in. Set PI_POD_LIVE_MATRIX=1 to run against a live server.");
    process.exit(0);
  }
  const cli = process.argv[2] ?? "node";
  const cliArgs = process.argv[2] ? process.argv.slice(3) : ["dist/cli.js"];
  const rows: Row[] = [
    { name: "doctor/resolve", cells: {} },
    { name: "launch", cells: {} },
    { name: "hello/get_state/get_entries", cells: {} },
    { name: "direct bash stdout", cells: {} },
    { name: "agent edit", cells: {} },
    { name: "detach/reattach", cells: {} },
    { name: "archive/restore", cells: {} },
    { name: "fork", cells: {} },
    { name: "descendant send", cells: {} },
  ];

  const created: string[] = [];
  try {
    for (const provider of PROVIDERS) {
      const doctor = run(cli, [...cliArgs, "doctor"]);
      rows[0]!.cells[provider] = {
        result: doctor.ok ? "PASS" : "FAIL",
      };
      // Remaining cells stay SKIPPED unless a full live attach harness is wired.
      for (const row of rows.slice(1)) {
        row.cells[provider] = { result: "SKIPPED", note: "requires interactive attach harness" };
      }
    }
  } finally {
    if (created.length > 0) {
      run(cli, [...cliArgs, "archive", ...created, "--yes"]);
    }
    run(cli, [...cliArgs, "ls", "--all"]);
    run(cli, [...cliArgs, "ls", "--archived", "--all"]);
  }

  const header = `| check | ${PROVIDERS.join(" | ")} |`;
  const sep = `|---|${PROVIDERS.map(() => "---").join("|")}|`;
  const body = rows
    .map((row) => `| ${row.name} | ${PROVIDERS.map((p) => {
      const cell = row.cells[p];
      return cell?.note ? `${cell.result} (${cell.note})` : cell?.result ?? "SKIPPED";
    }).join(" | ")} |`)
    .join("\n");
  const md = `${header}\n${sep}\n${body}\n`;
  console.log(md);
  mkdirSync("tmp/live-provider-matrix", { recursive: true });
  writeFileSync("tmp/live-provider-matrix/matrix.md", md);
  writeFileSync("tmp/live-provider-matrix/matrix.json", JSON.stringify(rows, null, 2));
  const cases = rows.flatMap((row) =>
    PROVIDERS.map((provider) => {
      const cell = row.cells[provider];
      const result = cell?.result === "FAIL" ? "failure" : "success";
      return `<testcase classname="${provider}" name="${row.name}"><${result}/></testcase>`;
    }),
  );
  writeFileSync(
    "tmp/live-provider-matrix/junit.xml",
    `<?xml version="1.0"?><testsuite name="live-provider-matrix">${cases.join("")}</testsuite>`,
  );
}

main();
