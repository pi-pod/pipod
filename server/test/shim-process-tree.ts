/**
 * Shared teardown for tests that spawn the agentd shim (a shim -> fake pi tree).
 * The old `child.kill("SIGKILL")` killed only the shim; the fake pi survived,
 * was reparented, and accumulated with a deleted cwd. `spawnShimTree` starts the
 * child as a POSIX process-group leader; `disposeShimTree` signals the whole
 * group, waits bounded, and throws if anything survives. Only the spawned
 * child's group is ever signalled.
 */
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

export type ShimTreeOptions = Omit<SpawnOptionsWithoutStdio, "detached">;

const childClosed = new WeakMap<ChildProcess, Promise<void>>();
const disposedChildren = new WeakSet<ChildProcess>();

export interface DisposeShimTreeOptions {
  /** SIGTERM the tree and wait graceMs before escalating to SIGKILL. Default false (force). */
  graceful?: boolean;
  /** Grace period after SIGTERM before SIGKILL escalation. Default 1000ms. */
  graceMs?: number;
  /** Bound on direct-child exit after SIGKILL. Default 5000ms. */
  timeoutMs?: number;
  /** Bound on group drain after the final sweep. Default 2000ms. */
  groupGraceMs?: number;
}

/** Spawn a test supervisor as an isolated process-group leader (POSIX). */
export function spawnShimTree(
  command: string,
  args: readonly string[],
  options: ShimTreeOptions = {},
): ChildProcessWithoutNullStreams {
  // detached is enforced after options: callers cannot opt out of isolation.
  const child = spawn(command, [...args], {
    ...options,
    ...(process.platform === "win32" ? {} : { detached: true as const }),
  });
  childClosed.set(child, new Promise((resolve) => child.once("close", () => resolve())));
  return child;
}

/** Signal every process in the child's group. Ignores only ESRCH (group already gone). */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || process.platform === "win32") return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
  }
}

function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
    return false;
  }
}

/** Resolve on the direct child's exit/error/close, or after timeoutMs (bounded). */
export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("error", done);
      child.removeListener("close", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.once("exit", done);
    child.once("error", done);
    child.once("close", done);
  });
}

function destroyStreams(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream?.destroy();
    } catch {
      // Best-effort: the kills above already ran.
    }
  }
}

/**
 * Reap a tree started with `spawnShimTree`. Force mode (default) goes straight
 * to SIGKILL; graceful mode tries SIGTERM first. Liveness is probed with
 * kill(-pgid, 0), which includes zombies until the host's init reaps them. Throws
 * if the direct child or any group member survives the bounded waits, or if a
 * group signal failed with anything but ESRCH. Safe on null/undefined.
 */
export async function disposeShimTree(
  child: ChildProcess | null | undefined,
  options: DisposeShimTreeOptions = {},
): Promise<void> {
  if (!child || disposedChildren.has(child)) return;
  const { graceful = false, graceMs = 1000, timeoutMs = 5000, groupGraceMs = 2000 } = options;
  if (child.pid === undefined) {
    // Spawn failed: no tree exists. Drain error/close (bounded) and return.
    await waitForChildExit(child, timeoutMs);
    destroyStreams(child);
    disposedChildren.add(child);
    return;
  }
  let signalError: unknown;
  const signalTree = (signal: NodeJS.Signals): void => {
    try {
      killGroup(child.pid, signal);
    } catch (error) {
      signalError ??= error;
    }
    try {
      child.kill(signal);
    } catch {
      // Already dead; the bounded waits below still apply.
    }
  };
  if (graceful) {
    signalTree("SIGTERM");
    await waitForChildExit(child, graceMs);
  }
  signalTree("SIGKILL");
  await waitForChildExit(child, timeoutMs);
  signalTree("SIGKILL");
  await waitForChildExit(child, 1000);
  const deadline = Date.now() + groupGraceMs;
  while (groupAlive(child.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  destroyStreams(child);
  const closed = childClosed.get(child);
  if (closed) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("disposeShimTree: child close timed out")), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`disposeShimTree: direct child survived teardown (pid ${child.pid})`);
  }
  if (groupAlive(child.pid)) {
    throw new Error(`disposeShimTree: process group survived teardown (pgid ${child.pid})`);
  }
  if (signalError) throw signalError;
  // A later fixture finally may call dispose again. Never re-signal a pgid
  // after successful cleanup: the OS could have reused it in the meantime.
  disposedChildren.add(child);
}
