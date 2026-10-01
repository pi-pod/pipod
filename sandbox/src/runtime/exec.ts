import { spawn, type SpawnOptions } from "node:child_process";

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
