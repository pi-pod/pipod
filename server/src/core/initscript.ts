/**
 * src/initscript.ts — phase 4 (§4.3, §6): upload and run the repo's `init.sh`.
 *
 * Output is streamed to the host terminal prefixed with `[init]` so bootstrap progress is
 * visible rather than a silent minute of nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PiPodError } from "./errors.js";
import { prefixedStreamer, debug, warn } from "./log.js";
import { confirm } from "./prompt.js";
import type { InitOnFailure } from "./config.js";
import type { Sandbox } from "./providers/types.js";

/** Uploaded outside the workdir, so it never shows up as workspace content. */
export const INIT_SCRIPT_REMOTE_PATH = "/tmp/pi-pod-init.sh";

export interface RunInitOptions {
  sandbox: Sandbox;
  /** Absolute path of init.sh on the host. */
  hostPath: string;
  /** cwd for the script — the pod workdir it is expected to populate (§4.3). */
  workdir: string;
  timeoutSeconds: number;
  onFailure: InitOnFailure;
  /** Extra env (markers) applied to this exec. */
  env?: Record<string, string>;
  /** Included in the failure hint when egress is restricted (§10). */
  egressRestricted: boolean;
  /** Remote path to upload to. Defaults to {@link INIT_SCRIPT_REMOTE_PATH}. */
  remotePath?: string;
  /** Stream prefix. Defaults to `[init]`. */
  logPrefix?: string;
}

export interface RunInitResult {
  ran: boolean;
  exitCode: number;
  /** Chronological, combined stdout/stderr tail. Present only for a failed script. */
  outputTail?: string;
}

export const INIT_OUTPUT_TAIL_BYTES = 8 * 1024;

/** Scoped redaction: server pod env must never enter the process-global cross-tenant registry. */
export function redactInitOutput(input: string, env: Record<string, string> = {}): string {
  let output = input;
  const values = [...new Set(Object.values(env).filter((value) => value.length >= 4))]
    .sort((left, right) => right.length - left.length);
  for (const value of values) output = output.split(value).join("[redacted]");
  return output;
}

class BoundedOutputTail {
  private value = Buffer.alloc(0);

  append(chunk: Uint8Array): void {
    const combined = Buffer.concat([this.value, Buffer.from(chunk)]);
    this.value = combined.subarray(Math.max(0, combined.length - INIT_OUTPUT_TAIL_BYTES));
  }

  get empty(): boolean {
    return this.value.length === 0;
  }

  text(env: Record<string, string>): string {
    return redactInitOutput(this.value.toString("utf8"), env);
  }
}

/** Redacts across provider chunk boundaries before streamed output reaches the shared logger. */
class ScopedStreamRedactor {
  private pending = "";
  private readonly decoder = new TextDecoder();
  private readonly values: string[];
  private readonly overlap: number;

  constructor(
    env: Record<string, string>,
    private readonly emit: (chunk: Uint8Array) => void,
  ) {
    this.values = [...new Set(Object.values(env).filter((value) => value.length >= 4))]
      .sort((left, right) => right.length - left.length);
    this.overlap = Math.max(0, ...this.values.map((value) => value.length - 1));
  }

  push(chunk?: Uint8Array): void {
    this.pending += chunk ? this.decoder.decode(chunk, { stream: true }) : this.decoder.decode();
    const final = chunk === undefined;
    const source = this.pending;
    const emitUntil = final ? source.length : Math.max(0, source.length - this.overlap);
    const out: string[] = [];
    let cursor = 0;
    while (cursor < emitUntil) {
      let nextStart = emitUntil;
      let nextSecret: string | null = null;
      for (const candidate of this.values) {
        const found = source.indexOf(candidate, cursor);
        if (found >= 0 && found < nextStart) {
          nextStart = found;
          nextSecret = candidate;
        }
      }
      if (!nextSecret) {
        out.push(source.slice(cursor, emitUntil));
        cursor = emitUntil;
        break;
      }
      if (nextStart > cursor) out.push(source.slice(cursor, nextStart));
      out.push("[redacted]");
      cursor = nextStart + nextSecret.length;
    }
    this.pending = source.slice(cursor);
    if (out.length > 0) this.emit(Buffer.from(out.join(""), "utf8"));
  }
}

function failureMessage(detail: string, outputTail: string): string {
  const lines = outputTail.trimEnd().split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return detail;
  // state_reason keeps a short prefix, so newest-first puts the cause there while the persisted
  // report retains the same bounded tail in normal chronological order.
  return `${detail}\nLast output (newest first, bounded):\n${lines.reverse().join("\n")}`;
}

export class InitScriptFailure extends PiPodError {
  constructor(
    detail: string,
    readonly scriptExitCode: number,
    readonly outputTail: string,
    opts: { hint?: string; cause?: unknown } = {},
  ) {
    super(failureMessage(detail, outputTail), opts);
    this.name = "InitScriptFailure";
  }
}

export async function runInitScript(opts: RunInitOptions): Promise<RunInitResult> {
  if (!fs.existsSync(opts.hostPath)) {
    debug(`no init script at ${opts.hostPath} — skipping phase 4`);
    return { ran: false, exitCode: 0 };
  }

  const contents = fs.readFileSync(opts.hostPath);
  const remotePath = opts.remotePath ?? INIT_SCRIPT_REMOTE_PATH;
  await opts.sandbox.uploadFile(remotePath, contents, 0o755);

  const prefix = opts.logPrefix ?? "[init]";
  const env = opts.env ?? {};
  const tail = new BoundedOutputTail();
  const stdout = new ScopedStreamRedactor(env, prefixedStreamer(prefix));
  const stderr = new ScopedStreamRedactor(env, prefixedStreamer(prefix));
  const onOutput = (stream: ScopedStreamRedactor) => (chunk: Uint8Array): void => {
    tail.append(chunk);
    stream.push(chunk);
  };
  const scriptName = path.basename(opts.hostPath);
  const hint = opts.egressRestricted
    ? "if it failed to download something, every host init.sh fetches from must be listed in egress.allow"
    : undefined;

  let result: Awaited<ReturnType<Sandbox["exec"]>>;
  try {
    result = await opts.sandbox.exec(["bash", remotePath], {
      cwd: opts.workdir,
      env: {
        // Must be non-interactive (§4.3).
        DEBIAN_FRONTEND: "noninteractive",
        CI: "1",
        ...env,
      },
      timeoutMs: opts.timeoutSeconds * 1000,
      onStdout: onOutput(stdout),
      onStderr: onOutput(stderr),
    });
  } catch (error) {
    const outputTail = tail.text(env);
    const causeMessage = redactInitOutput(error instanceof Error ? error.message : String(error), env);
    throw new InitScriptFailure(
      `${scriptName} could not run: ${causeMessage}`,
      -1,
      outputTail,
      { ...(hint ? { hint } : {}), cause: error },
    );
  } finally {
    stdout.push();
    stderr.push();
  }

  if (tail.empty && result.output) tail.append(Buffer.from(result.output, "utf8"));
  if (result.exitCode === 0) return { ran: true, exitCode: 0 };

  const outputTail = tail.text(env);
  const timedOut = looksLikeTimeout(result);
  const detail = timedOut
    ? `${scriptName} exceeded initTimeoutSeconds (${opts.timeoutSeconds}s)`
    : `${scriptName} exited with code ${result.exitCode}`;

  switch (opts.onFailure) {
    case "continue":
      warn(`${detail} — continuing because initOnFailure is "continue"`);
      if (hint) warn(hint);
      return { ran: true, exitCode: result.exitCode, outputTail };

    case "prompt": {
      warn(detail);
      if (hint) warn(hint);
      const proceed = await confirm("Continue into the pi session anyway?", {
        nonInteractiveDefault: false,
      });
      if (proceed) return { ran: true, exitCode: result.exitCode, outputTail };
      throw new InitScriptFailure(`aborted after init failure: ${detail}`, result.exitCode, outputTail, {
        ...(hint ? { hint } : {}),
      });
    }

    case "abort":
    default:
      throw new InitScriptFailure(detail, result.exitCode, outputTail, {
        hint:
          hint ??
          'fix .pi-pod/init.sh, or set "initOnFailure": "prompt" | "continue" in .pi-pod/config.json',
      });
  }
}

/** Adapters surface timeouts differently; the exit code is the portable signal. */
function looksLikeTimeout(result: { exitCode: number; output?: string }): boolean {
  if (result.exitCode === 124) return true; // GNU timeout convention
  return /timed?\s*out/i.test(result.output ?? "");
}
