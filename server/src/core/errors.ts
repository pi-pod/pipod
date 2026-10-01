/** Exit codes used by the launcher. Remote pi exit codes pass through unchanged (§8). */
export const EXIT = {
  OK: 0,
  /** Launcher-level failure (preflight, provisioning, teardown). */
  FAILURE: 1,
  /** Bad CLI usage. */
  USAGE: 2,
  /** Interrupted (Ctrl-C) — §9. */
  INTERRUPTED: 130,
} as const;

/**
 * An error that is the user's to fix. Printed without a stack trace, with a remediation
 * hint when there is one. Everything else is a bug and prints a full stack.
 */
export class PiPodError extends Error {
  readonly hint?: string;
  readonly exitCode: number;
  /** HTTP status when this came from a server response, so callers can tell 404 from 502. */
  readonly status?: number;
  /** A stable machine-readable server/protocol error code, when one is available. */
  readonly code?: string;
  /** A blip — an unreachable server or a 5xx — rather than a refusal that will repeat. */
  readonly transient: boolean;
  /**
   * Safe server `detail` payload passthrough (capacity `reason`/`retryable` hints,
   * credential metadata). Presenters must render only validated codes/numbers from it —
   * never raw provider text, URLs, or secrets.
   */
  readonly detail?: unknown;

  constructor(
    message: string,
    opts: {
      hint?: string;
      exitCode?: number;
      cause?: unknown;
      status?: number;
      code?: string;
      transient?: boolean;
      detail?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "PiPodError";
    this.hint = opts.hint;
    this.exitCode = opts.exitCode ?? EXIT.FAILURE;
    this.status = opts.status;
    this.code = opts.code;
    this.transient = opts.transient ?? (opts.status !== undefined && opts.status >= 500);
    this.detail = opts.detail;
  }
}

/** Raised when the user cancels (Ctrl-C, or declining a confirmation). */
export class CancelledError extends PiPodError {
  constructor(message = "Cancelled") {
    super(message, { exitCode: EXIT.INTERRUPTED });
    this.name = "CancelledError";
  }
}

export function isPiPodError(e: unknown): e is PiPodError {
  return e instanceof PiPodError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Close reasons where a later keystroke can still start the sandbox. Logical
 * archive (`archived`) restores in place on wake, then attaches.
 */
export const WAKEABLE_ASLEEP_REASONS = new Set([
  "idle_stop",
  "provider_stopped",
  "provider_archived",
  "archive",
  "archived",
]);

export function isWakeableAsleepReason(reason: string): boolean {
  return WAKEABLE_ASLEEP_REASONS.has(reason);

}

export function isRestoreRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof PiPodError ? error.status : undefined;
  return status === 409 && /restore the pod/i.test(message);

}

/**
 * The gateway closed the session because the pod is stopped or archived (close 4420).
 * Distinct from a broken transport: the TUI stays up and a later user action can wake it.
 */
export class PodAsleepError extends PiPodError {
  readonly reason: string;

  constructor(reason: string) {
    super(`pod is asleep (${reason})`, {
      hint: isWakeableAsleepReason(reason)
        ? reason === "archived" || reason === "archive" || reason === "provider_archived"
          ? "press Enter to restore & reattach, or /quit to exit"
          : "press Enter or type to wake it, or /quit to exit"
        : "/quit to exit",
    });
    this.name = "PodAsleepError";
    this.reason = reason;
  }

}

export function isPodAsleepError(e: unknown): e is PodAsleepError {
  return e instanceof PodAsleepError;

}
