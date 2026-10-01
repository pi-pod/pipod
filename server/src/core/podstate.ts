/**
 * Machine-local logical pod lifecycle state.
 *
 * Providers remain the inventory and execution backend, but their running/stopped/cold
 * states are implementation details. A pod is active until the user archives it here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { hostHome } from "./hostconfig.js";
import { USER_CONFIG_DIR } from "./userconfig.js";

export type LogicalPodState = "active" | "archived";

export const POD_STATES_FILE = "pod-states.json";

interface PodStatesFile {
  version: 1;
  states: Record<string, { state: LogicalPodState; updatedAt: string }>;
}

export function podStatesPath(home: string | null = hostHome()): string | null {
  return home ? path.join(home, USER_CONFIG_DIR, POD_STATES_FILE) : null;
}

function emptyFile(): PodStatesFile {
  return { version: 1, states: {} };
}

function key(provider: string, podId: string): string {
  return `${provider}:${podId}`;
}

/** Missing and malformed registries are treated as empty; state metadata must not break list. */
export function readPodStates(home: string | null = hostHome()): PodStatesFile {
  const file = podStatesPath(home);
  if (!file || !fs.existsSync(file)) return emptyFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PodStatesFile>;
    if (raw.version !== 1 || !raw.states || typeof raw.states !== "object") return emptyFile();
    const states: PodStatesFile["states"] = {};
    for (const [id, value] of Object.entries(raw.states)) {
      if (
        value &&
        typeof value === "object" &&
        ((value as { state?: unknown }).state === "active" || (value as { state?: unknown }).state === "archived")
      ) {
        states[id] = {
          state: (value as { state: LogicalPodState }).state,
          updatedAt:
            typeof (value as { updatedAt?: unknown }).updatedAt === "string"
              ? (value as { updatedAt: string }).updatedAt
              : new Date(0).toISOString(),
        };
      }
    }
    return { version: 1, states };
  } catch {
    return emptyFile();
  }
}

/** Mutations must not turn a corrupt registry into silent loss of unrelated lifecycle intent. */
function readPodStatesForMutation(home: string | null): PodStatesFile {
  const file = podStatesPath(home);
  if (!file || !fs.existsSync(file)) return emptyFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PodStatesFile>;
    if (raw.version !== 1 || !raw.states || typeof raw.states !== "object") throw new Error("invalid shape");
    const parsed = readPodStates(home);
    if (Object.keys(parsed.states).length !== Object.keys(raw.states).length) throw new Error("invalid entry");
    return parsed;
  } catch {
    throw new Error(`pod lifecycle state file is malformed; repair or move ${file} before changing pod state`);
  }
}

/** An untracked pod is active regardless of the provider's current execution/storage tier. */
export function logicalPodState(
  provider: string,
  podId: string,
  home: string | null = hostHome(),
): LogicalPodState {
  return readPodStates(home).states[key(provider, podId)]?.state ?? "active";
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;

function withStateLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting to update pod lifecycle state");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function writePodStates(file: string, current: PodStatesFile): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** Persist an explicit archive/restore action atomically. */
export function rememberLogicalPodState(
  provider: string,
  podId: string,
  state: LogicalPodState,
  home: string | null = hostHome(),
): void {
  const file = podStatesPath(home);
  if (!file) throw new Error("cannot resolve a home directory to store pod state");
  withStateLock(file, () => {
    const current = readPodStatesForMutation(home);
    current.states[key(provider, podId)] = { state, updatedAt: new Date().toISOString() };
    writePodStates(file, current);
  });
}

/** Remove metadata after permanent deletion. Best effort, like the display-name registry. */
export function forgetLogicalPodState(
  provider: string,
  podId: string,
  home: string | null = hostHome(),
): void {
  const file = podStatesPath(home);
  if (!file) return;
  try {
    withStateLock(file, () => {
      if (!fs.existsSync(file)) return;
      const current = readPodStatesForMutation(home);
      if (!(key(provider, podId) in current.states)) return;
      delete current.states[key(provider, podId)];
      writePodStates(file, current);
    });
  } catch {
    // Metadata cleanup cannot make a successful provider deletion fail.
  }
}
