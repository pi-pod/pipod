/**
 * src/client/headless.ts — non-TTY output (§5.5).
 *
 * When stdout is not a TTY (piped/scripted runs, --prompt one-shots), the same
 * RemoteRpcClient feeds this line printer instead of the TUI: text deltas to stdout, tool
 * activity to stderr, done after agent_settled. Same transport, same protocol, one renderer
 * swapped.
 */
import type { RpcClientBase } from "./rpc.js";

/** Pi flags that consume a value, so prompt extraction never eats a flag argument. */
const VALUE_FLAGS = new Set([
  "--model", "-m", "--provider", "--session", "--session-id", "--session-dir", "--thinking",
  "--extension", "-e", "--mode", "--resume", "-r", "--fork", "--export", "--api-key", "--tui-mode",
]);

export type TuiMode = "regular" | "fullscreen";

/** Match Pi's last-option-wins parsing for the local InteractiveMode renderer. */
export function tuiModeFromArgv(argv: string[]): TuiMode | undefined {
  let mode: TuiMode | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--tui-mode") continue;
    const value = argv[++i];
    if (value === "regular" || value === "fullscreen") mode = value;
  }
  return mode;
}

/**
 * Split a Pi RPC invocation into its startup prompt and the arguments Pi should still see.
 * Positional startup messages do not run automatically under `--mode rpc`, so every renderer
 * submits them as a `prompt` command instead. `-p/--print` is likewise implemented by the
 * non-TTY renderer and must not reach the long-lived Pi process.
 */
export function extractStartupPrompt(piArgs: string[]): { prompt: string | undefined; args: string[] } {
  const args: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < piArgs.length; i++) {
    const arg = piArgs[i]!;
    if (arg === "-p" || arg === "--print") continue;
    if (arg.startsWith("-")) {
      args.push(arg);
      if (VALUE_FLAGS.has(arg) && i + 1 < piArgs.length) args.push(piArgs[++i]!);
      continue;
    }
    positionals.push(arg);
  }
  return { prompt: positionals.length > 0 ? positionals.join(" ") : undefined, args };
}

export interface HeadlessOptions {
  rpc: RpcClientBase;
  /** Prompt to send once connected; omitted means "render whatever pi is already doing". */
  prompt?: string | undefined;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

interface StreamEvent {
  type?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolName?: string;
  args?: unknown;
  code?: number | null;
}

/**
 * Render one agent run as plain lines. Resolves with pi's exit code when pi exits, or null
 * after the run settles with pi still up (the caller then quits it via the shim).
 */
export function runHeadless(opts: HeadlessOptions): Promise<number | null> {
  const { rpc, stdout, stderr } = opts;

  return new Promise((resolve, reject) => {
    let settled = false;
    let outputEndsWithNewline = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      offEvents();
      offControl();
      resolve(code);
    };

    const offEvents = rpc.onEvent((event) => {
      const e = event as StreamEvent;
      switch (e.type) {
        case "message_update":
          if (e.assistantMessageEvent?.type === "text_delta" && e.assistantMessageEvent.delta) {
            stdout.write(e.assistantMessageEvent.delta);
            outputEndsWithNewline = e.assistantMessageEvent.delta.endsWith("\n");
          }
          break;
        case "tool_execution_start":
          stderr.write(`[tool] ${e.toolName ?? "unknown"}\n`);
          break;
        case "agent_settled":
          if (!outputEndsWithNewline) stdout.write("\n");
          finish(null);
          break;
      }
    });

    const offControl = rpc.onControl((event) => {
      if (event.event === "pi_exit") {
        finish(event.code);
      } else if (event.event === "pi_stderr") {
        stderr.write(Buffer.from(event.data, "base64"));
      }
    });

    if (opts.prompt !== undefined) {
      rpc.prompt(opts.prompt).catch((e: unknown) => {
        offEvents();
        offControl();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    }
  });
}
