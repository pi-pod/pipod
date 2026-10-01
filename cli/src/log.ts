/**
 * src/log.ts — the launcher's logger. Everything user-visible goes through here so that
 * redaction (§7.3) is structural rather than something each call site has to remember.
 */
import { stripVTControlCharacters } from "node:util";
import { redact } from "./redact.js";

let verbose = false;
let colorEnabled = process.stderr.isTTY === true && !process.env.NO_COLOR;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function isVerbose(): boolean {
  return verbose;
}

export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
}

const CODES = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
} as const;

function paint(code: keyof typeof CODES, s: string): string {
  return colorEnabled ? `${CODES[code]}${s}${CODES.reset}` : s;
}

export const color = {
  dim: (s: string) => paint("dim", s),
  bold: (s: string) => paint("bold", s),
  red: (s: string) => paint("red", s),
  yellow: (s: string) => paint("yellow", s),
  cyan: (s: string) => paint("cyan", s),
  green: (s: string) => paint("green", s),
};

/**
 * Diagnostics go to stderr so that stdout stays clean for the PTY stream and for
 * machine-readable output (`--dry-run`, `--version`).
 */
function write(line: string): void {
  process.stderr.write(redact(line) + "\n");
}

export function info(msg: string): void {
  write(`${paint("cyan", "pi pod")} ${msg}`);
}

export function step(phase: string, msg: string): void {
  write(`${paint("cyan", "pi pod")} ${paint("dim", `[${phase}]`)} ${msg}`);
}

export function warn(msg: string): void {
  write(`${paint("yellow", "warning")} ${msg}`);
}

export function error(msg: string): void {
  write(`${paint("red", "error")} ${msg}`);
}

/** Multi-line hints are one hint: the prefix appears once, continuation lines align under it. */
export function hint(msg: string): void {
  const lines = msg.split("\n");
  write(`${paint("dim", "  hint:")} ${lines[0] ?? ""}`);
  for (const line of lines.slice(1)) write(paint("dim", `        ${line}`));
}

export function debug(msg: string): void {
  if (verbose) write(`${paint("dim", "debug")} ${paint("dim", msg)}`);
}

export function plain(msg: string): void {
  write(msg);
}

/**
 * Direct stdout writer for command results and machine-readable output; still redacted.
 * Color is useful at a terminal but must never leak into a pipe or redirected file.
 */
export function out(msg: string): void {
  const line = redact(msg);
  process.stdout.write((process.stdout.isTTY === true ? line : stripVTControlCharacters(line)) + "\n");
}

/**
 * Wall-clock phase timings for one launch/attach, so the summary line can say where the
 * time went. Overlapping (parallelized) phases each record their own duration; the summary
 * total is wall time, not the sum.
 */
export interface PhaseTiming {
  phase: string;
  ms: number;
}

const phaseTimings: PhaseTiming[] = [];

export function resetPhaseTimings(): void {
  phaseTimings.length = 0;
}

export function recordPhase(phase: string, ms: number): void {
  phaseTimings.push({ phase, ms });
}

export async function timePhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    recordPhase(phase, Date.now() - startedAt);
  }
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One line naming total wall time and every phase that cost at least 100ms. */
export function phaseSummary(label: string, totalMs: number): string {
  const parts = phaseTimings.filter((t) => t.ms >= 100).map((t) => `${t.phase} ${fmtSeconds(t.ms)}`);
  const breakdown = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  return `${label} in ${fmtSeconds(totalMs)}${breakdown}`;
}

/**
 * Print a periodic "still …" line while a long provider operation runs, so a multi-minute
 * wait is distinguishable from a hang. The line names the elapsed time and, when known,
 * roughly how long the wait usually takes.
 */
export const LIVENESS_INTERVAL_MS = 15_000;

export async function withLiveness<T>(
  label: string,
  work: () => Promise<T>,
  opts: { intervalMs?: number; expectation?: string } = {},
): Promise<T> {
  const intervalMs = opts.intervalMs ?? LIVENESS_INTERVAL_MS;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const usually = opts.expectation ? `, ${opts.expectation}` : "";
    write(`${paint("cyan", "pi pod")} ${paint("dim", `still ${label} (${elapsed}s elapsed${usually})`)}`);
  }, intervalMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Stream a child stream to the terminal with a prefix (`[init]`, §4.3). Handles partial
 * lines so a chunk boundary never splits a prefix.
 */
export function prefixedStreamer(prefix: string): (chunk: Uint8Array) => void {
  let pending = "";
  const flushLine = (line: string) => write(`${paint("dim", prefix)} ${line}`);
  return (chunk: Uint8Array) => {
    pending += Buffer.from(chunk).toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) flushLine(line);
    // Guard against a runaway line with no newline ever arriving.
    if (pending.length > 8192) {
      flushLine(pending);
      pending = "";
    }
  };
}
