/**
 * Shared PTY lifecycle helpers. The helpers stay provider-agnostic so tests can exercise the
 * policy without an SDK.
 */
import { PiPodError } from "../errors.js";

export const MANAGED_PTY_PREFIX = "pi-pod-";

export interface ListedPtySession {
  id: string;
  active: boolean;
}

export function isManagedPtyId(id: string): boolean {
  return id.startsWith(MANAGED_PTY_PREFIX);
}

export function isPtyExhaustedError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("/dev/ptmx") ||
    message.includes("no space left on device") ||
    message.includes("enospc") ||
    message.includes("pty") && message.includes("no space")
  );
}

export function selectSafeOrphanPtyIds(sessions: readonly ListedPtySession[]): string[] {
  return sessions.filter((session) => isManagedPtyId(session.id) && !session.active).map((session) => session.id);
}

export interface PtyCounts {
  listed: number;
  managedInactive: number;
  managedActive: number;
  foreign: number;
}

export function countPtySessions(sessions: readonly ListedPtySession[]): PtyCounts {
  let managedInactive = 0;
  let managedActive = 0;
  let foreign = 0;
  for (const session of sessions) {
    if (!isManagedPtyId(session.id)) {
      foreign += 1;
    } else if (session.active) {
      managedActive += 1;
    } else {
      managedInactive += 1;
    }
  }
  return { listed: sessions.length, managedInactive, managedActive, foreign };
}

export class ProviderResourceExhaustedError extends PiPodError {
  override readonly code = "provider_resource_exhausted" as const;
  readonly ptyCounts: PtyCounts;

  constructor(message: string, opts: { hint?: string; cause?: unknown; ptyCounts: PtyCounts }) {
    super(message, { hint: opts.hint, cause: opts.cause, transient: false });
    this.name = "ProviderResourceExhaustedError";
    this.ptyCounts = opts.ptyCounts;
  }
}

export function resourceExhaustedError(counts: PtyCounts, cause?: unknown): ProviderResourceExhaustedError {
  return new ProviderResourceExhaustedError(
    "provider PTY slots are exhausted — this is not disk exhaustion",
    {
      hint:
        counts.managedInactive === 0
          ? "no inactive pi-pod PTY sessions could be reclaimed; wait for an existing session to exit, or raise the host PTY limit"
          : "inactive managed PTY sessions were reclaimed but a new session still could not be created",
      cause,
      ptyCounts: counts,
    },
  );
}

export async function reapInactiveManagedPtys(args: {
  list: () => Promise<ListedPtySession[]>;
  kill: (id: string) => Promise<void>;
}): Promise<{ reaped: string[]; counts: PtyCounts }> {
  const sessions = await args.list();
  const counts = countPtySessions(sessions);
  const orphans = selectSafeOrphanPtyIds(sessions);
  const reaped: string[] = [];
  for (const id of orphans) {
    try {
      await args.kill(id);
      reaped.push(id);
    } catch {
      // Best-effort: a race that activates the session must not become a kill of a live one.
    }
  }
  return { reaped, counts };
}
