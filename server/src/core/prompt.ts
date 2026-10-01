/**
 * src/prompt.ts — interactive confirmations.
 *
 * Every prompt has a non-interactive answer baked in, because the launcher must behave
 * predictably in CI: warnings that require confirmation abort when there is no TTY (§7.1),
 * while warnings that are purely informational proceed (§9).
 */
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import { color, warn } from "./log.js";

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/**
 * Reads a secret without echoing it. Terminals show what you type by default, and a
 * credential typed at a prompt would otherwise sit in the scrollback of a shared screen.
 */
export async function promptSecret(question: string, signal?: AbortSignal): Promise<string> {
  // The prompt is written directly and the interface is given an output stream that throws
  // every byte away, so line editing still works while nothing is echoed. Muting through
  // readline's internals instead would depend on `_writeToOutput`, which the promises API
  // does not have.
  process.stderr.write(question);
  const discard = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: discard, terminal: true });
  try {
    const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
    const question = signal ? rl.question("", { signal }) : rl.question("");
    const answer = await Promise.race([question, closed]);
    return typeof answer === "string" ? answer.trim() : "";
  } catch {
    return "";
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

export interface ConfirmOptions {
  /** Answer used when there is no TTY. */
  nonInteractiveDefault: boolean;
  /** Skip the prompt entirely and return this. */
  assumeYes?: boolean;
}

export async function confirm(question: string, opts: ConfirmOptions): Promise<boolean> {
  if (opts.assumeYes) return true;
  if (!isInteractive()) {
    // Declining unseen would make the command fail without a word about why.
    if (!opts.nonInteractiveDefault) {
      warn(`${question} — no: there is no terminal to answer${"assumeYes" in opts ? " (pass --yes to answer yes)" : ""}`);
    }
    return opts.nonInteractiveDefault;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    // Two ways the answer never arrives, and they surface differently. A Ctrl-D keystroke is
    // an EOT byte that readline rejects the pending question over; stdin closing outright
    // just ends the interface, leaving that promise to sit unsettled forever. Racing the
    // close event covers the second — awaiting the question alone hangs the launcher.
    const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
    const answer = await Promise.race([rl.question(`${color.yellow("?")} ${question} [y/N] `), closed]);
    if (answer === null) {
      process.stderr.write("\n");
      return false;
    }
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    // Ctrl-D at the prompt closes stdin, which rejects the pending question. That is a
    // declined answer, not a crash — without this the launcher dies on an AbortError and
    // prints a Node stack trace over the very warning it was asking about.
    //
    // Deliberately `false` rather than `nonInteractiveDefault`: the two differ for the
    // teardown prompt, whose non-interactive default is to delete so CI reaps its pods.
    // A human who just read "modified file(s) will be destroyed" and hit Ctrl-D is answering
    // the `[y/N]` they were shown, and N is the side that keeps their work.
    process.stderr.write("\n");
    return false;
  } finally {
    rl.close();
  }
}
