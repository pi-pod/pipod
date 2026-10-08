import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every external binary this service drives goes through here: argv arrays, never a shell. */
export async function run(
  file: string,
  args: string[],
  opts: SpawnOptions & { input?: string } = {},
): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Exit status and stderr of a child whose stdout the caller streams elsewhere. */
export function waitForChild(child: ChildProcess): Promise<ChildResult> {
  let stderr = "";
  if (child.stderr === null) throw new Error("child process stderr is not piped");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

export function childError(command: string, result: ChildResult): Error | null {
  if (result.code === 0) return null;
  const status = result.signal === null ? `exit code ${String(result.code)}` : `signal ${result.signal}`;
  const detail = result.stderr.trim();
  return new Error(`${command} failed with ${status}${detail === "" ? "" : `: ${detail}`}`);
}

export async function runOk(
  file: string,
  args: string[],
  opts: SpawnOptions & { input?: string } = {},
): Promise<string> {
  const r = await run(file, args, opts);
  if (r.code !== 0) {
    throw new Error(`${file} ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}
