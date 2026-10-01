/**
 * src/client/shell.ts — the one remaining raw-PTY consumer (§2, §5.4).
 *
 * An explicit interactive shell — /pod shell, and the post-exit shell — opens a plain PTY
 * and forwards bytes. A shell is terminal-shaped by nature; this is a different feature from
 * the session protocol, not a second session mode, and it shares nothing with it. Scoped to
 * a dumb passthrough with a static restore string (§15).
 */
import { randomUUID } from "node:crypto";
import type { Sandbox } from "../providers/types.js";

/** Undo the terminal modes a remote shell (or a full-screen program in it) may leave on. */
const SHELL_TERMINAL_RESTORE =
  "\x1b[<u\x1b[=0;1u" + // kitty keyboard
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" + // mouse reporting
  "\x1b[?2004l" + // bracketed paste
  "\x1b[?1049l" + // back to the main screen
  "\x1b[?25h\x1b[0m"; // cursor visible, no leftover colour

export interface RawShellOptions {
  sandbox: Sandbox;
  cwd: string;
  env: Record<string, string>;
  argv?: string[];
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Deterministic completion seams for provider-independent tests. */
  completionPollMs?: number;
  transportFailureTimeoutMs?: number;
  readCompletion?: ((path: string) => Promise<string | null>) | undefined;
}

/** Run an interactive shell in the clone; resolves with its exit code when it ends. */
export async function runRawShell(opts: RawShellOptions): Promise<number | null> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const completionPath = `/tmp/pi-pod-shell-${randomUUID()}.exit`;
  const completionToken = randomUUID();
  const shellInitPath = `${completionPath}.rc`;
  let launchArgv: string[];
  if (opts.argv) {
    launchArgv = [
      "bash",
      "-lc",
      'set +e; finish() { code=$?; trap - EXIT; printf "\\036PI_POD_SHELL_DONE:%s:%s\\037" "$PI_POD_SHELL_TOKEN" "$code"; printf "%s\\n" "$code" > "$PI_POD_SHELL_DONE"; exit "$code"; }; trap finish EXIT; "$@"',
      "pi-pod-shell-wrapper",
      ...opts.argv,
    ];
  } else {
    const shellInit = [
      '[[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"',
      "trap 'code=$?; trap - EXIT; printf \"\\\\036PI_POD_SHELL_DONE:%s:%s\\\\037\" \"$PI_POD_SHELL_TOKEN\" \"$code\"; printf \"%s\\\\n\" \"$code\" > \"$PI_POD_SHELL_DONE\"; rm -f \"$PI_POD_SHELL_DONE.rc\"; exit \"$code\"' EXIT",
    ].join("\n");
    await opts.sandbox.uploadFile(shellInitPath, Buffer.from(`${shellInit}\n`, "utf8"), 0o600);
    launchArgv = ["bash", "--rcfile", shellInitPath, "-i"];
  }

  const session = await opts.sandbox.openPty({
    argv: launchArgv,
    cols: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
    cwd: opts.cwd,
    env: {
      ...opts.env,
      PI_POD_SHELL_DONE: completionPath,
      PI_POD_SHELL_TOKEN: completionToken,
    },
  });

  // The local TUI leaves stdin in utf8 mode, so data may arrive as strings. Provider PTYs
  // require bytes, and the input handler below normalizes both shapes.
  const wasRaw = stdin.isRaw === true;
  const canRaw = typeof stdin.setRawMode === "function" && stdin.isTTY === true;
  if (canRaw) stdin.setRawMode(true);
  stdin.resume();

  const onStdin = (chunk: string | Buffer) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    session.write(bytes);
  };
  const onResize = () => session.resize(stdout.columns ?? 80, stdout.rows ?? 24);
  let cancelled = false;
  let resolveHangup!: (code: null) => void;
  const hangup = new Promise<null>((resolve) => {
    resolveHangup = resolve;
  });
  const onHangup = () => resolveHangup(null);

  const sentinelPrefix = Buffer.from(`\x1ePI_POD_SHELL_DONE:${completionToken}:`, "utf8");
  const sentinelSuffix = 0x1f;
  let pendingOutput = Buffer.alloc(0);
  let resolveSentinel!: (code: number | null) => void;
  const sentinel = new Promise<number | null>((resolve) => { resolveSentinel = resolve; });
  const flushPendingOutput = () => {
    if (pendingOutput.length > 0) stdout.write(pendingOutput);
    pendingOutput = Buffer.alloc(0);
  };
  session.onData((data) => {
    pendingOutput = Buffer.concat([pendingOutput, Buffer.from(data)]);
    const start = pendingOutput.indexOf(sentinelPrefix);
    if (start >= 0) {
      const end = pendingOutput.indexOf(sentinelSuffix, start + sentinelPrefix.length);
      if (end < 0) {
        if (start > 0) stdout.write(pendingOutput.subarray(0, start));
        pendingOutput = pendingOutput.subarray(start);
        return;
      }
      if (start > 0) stdout.write(pendingOutput.subarray(0, start));
      const code = Number.parseInt(
        pendingOutput.subarray(start + sentinelPrefix.length, end).toString("utf8"),
        10,
      );
      const remainder = pendingOutput.subarray(end + 1);
      pendingOutput = Buffer.alloc(0);
      if (remainder.length > 0) stdout.write(remainder);
      resolveSentinel(Number.isFinite(code) ? code : null);
      return;
    }
    // Keep only a suffix that could actually be the beginning of a split sentinel. Holding
    // sentinelPrefix.length bytes unconditionally makes ordinary short prompts disappear.
    const keep = trailingPrefixLength(pendingOutput, sentinelPrefix);
    const emitLength = pendingOutput.length - keep;
    if (emitLength > 0) stdout.write(pendingOutput.subarray(0, emitLength));
    pendingOutput = pendingOutput.subarray(emitLength);
  });
  stdin.on("data", onStdin);
  process.on("SIGWINCH", onResize);
  process.on("SIGHUP", onHangup);
  process.on("SIGTERM", onHangup);

  const providerExit = new Promise<number | null>((resolve) => session.onExit((code) => {
    flushPendingOutput();
    resolve(code);
  }));
  const completion = watchShellCompletion(opts, completionPath, () => cancelled);

  try {
    return await Promise.race([providerExit, sentinel, completion, hangup]);
  } finally {
    cancelled = true;
    stdin.off("data", onStdin);
    process.off("SIGWINCH", onResize);
    process.off("SIGHUP", onHangup);
    process.off("SIGTERM", onHangup);
    flushPendingOutput();
    session.close();
    stdout.write(SHELL_TERMINAL_RESTORE);
    if (canRaw && !wasRaw) stdin.setRawMode(false);
    stdin.pause();
    await Promise.race([
      opts.sandbox.exec(["rm", "-f", completionPath, shellInitPath], { timeoutMs: 1_000 }).catch(() => undefined),
      delay(1_000),
    ]);
  }
}

async function watchShellCompletion(
  opts: RawShellOptions,
  path: string,
  isCancelled: () => boolean,
): Promise<number | null> {
  const pollMs = opts.completionPollMs ?? 100;
  const transportFailureTimeoutMs = opts.transportFailureTimeoutMs ?? 5_000;
  let transportFailedAt: number | null = null;

  while (!isCancelled()) {
    try {
      const state = await withHostTimeout(
        opts.readCompletion
          ? opts.readCompletion(path)
          : readCompletionState(opts.sandbox, path),
        Math.min(1_000, transportFailureTimeoutMs),
      );
      transportFailedAt = null;
      const text = opts.readCompletion && state !== null ? `done:${state}` : state;
      if (text?.startsWith("done:")) {
        // Redirection creates the file before writing the status. The newline emitted by the
        // trap is the commit marker: an empty or numeric-prefix read is still "running".
        const match = /^(\d+)\r?\n$/.exec(text.slice("done:".length));
        if (match) return Number.parseInt(match[1]!, 10);
      }
    } catch {
      transportFailedAt ??= Date.now();
      if (Date.now() - transportFailedAt >= transportFailureTimeoutMs) return null;
    }
    await delay(pollMs);
  }
  return null;
}

async function readCompletionState(sandbox: Sandbox, path: string): Promise<string | null> {
  const result = await sandbox.exec(
    ["bash", "-lc", 'if test -f "$1"; then printf "done:"; cat "$1"; else exit 1; fi', "pi-pod-shell-read", path],
    { timeoutMs: 5_000 },
  );
  return result.exitCode === 0 ? (result.output ?? "") : null;
}

async function withHostTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("shell completion poll timed out")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function trailingPrefixLength(data: Buffer, prefix: Buffer): number {
  const max = Math.min(data.length, prefix.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (data.subarray(data.length - length).equals(prefix.subarray(0, length))) return length;
  }
  return 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
