/**
 * src/account/workstation.ts — the personal workstation (SaaS edition) as the client sees it.
 *
 * On the SaaS backend every user gets a whole machine of their own — a "workstation" — and it
 * sleeps when idle. Any call that needs it while it is asleep or coming up is refused with a
 * typed, retryable HTTP 503 (or WebSocket close 4420) naming the workstation, its durable
 * operation, and how long to wait before asking again. That refusal is NOT fleet pressure, is
 * not the user's concurrency limit, and never means anything was lost: a stopped workstation
 * keeps every workspace on its own disk.
 *
 * The honest number matters here. Production measured, 2026-09-10 (ten operations across two
 * hosts in one evening — measurements, not an SLA):
 *
 *   cold create → ready    407 s (host with eight pods), 708 s (empty host)
 *   resume      → ready    243 s, 690 s, 483 s, 312 s, 357 s
 *   pod launch  → ready    46 s, once the workstation is already warm
 *
 * So the copy in this file says "several minutes" and shows elapsed time, and never promises a
 * duration the server did not send. The old fleet copy ("waiting for fleet capacity", "ask an
 * owner to register capacity") stays valid for a real shared fleet on the self-hosted backend
 * and must never be reached from here.
 *
 * Everything is validated the way the server validates it on the way out
 * (`pi-pod-server/src/server/safe-errors.ts`): the reason against the allowlist, the host id
 * against the workstation route's own rule, the status href RECOMPUTED from the id rather than
 * trusted, the retry hint bounded, the operation reduced to the seven fields the status route
 * exposes. A malformed field means "no detail", never a forged one.
 */

import { CancelledError, isWorkstationAsleepReason, PiPodError, WORKSTATION_ASLEEP_REASONS } from "../errors.js";
import { color, debug, step } from "../log.js";

/** Path shape of the owned-workstation status route, and of `hostId` inside a demand. */
const WORKSTATION_HOST_ID_RULE = /^boat-[A-Za-z0-9._-]{1,180}$/;
/** `sandbox_hosts.boat_state`. */
const WORKSTATION_STATES: ReadonlySet<string> = new Set([
  "provisioning", "starting", "running", "stopping", "stopped", "error", "unknown", "deleting", "deleted",
]);
/** `boat_operations.kind` / `.state`, and the bounded phase slug the controller writes. */
const OPERATION_KINDS: ReadonlySet<string> = new Set([
  "create", "resume", "stop", "delete", "publish", "activate", "ttl",
]);
const OPERATION_STATES: ReadonlySet<string> = new Set([
  "pending", "running", "uncertain", "succeeded", "failed", "cancelled",
]);
const OPERATION_ID_RULE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PHASE_RULE = /^[A-Za-z0-9._:-]{1,64}$/;
const ERROR_CODE_RULE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The six reasons a host-demand refusal can carry (server `BOAT_HOST_DEMAND_REASONS`). A
 * seventh value from a newer server is tolerated: `retryable` on the wire decides, not this
 * list, and unrecognized reasons fall back to the server's own sentence.
 */
export const WORKSTATION_DEMAND_REASONS = [
  "host_starting",
  "host_stopped",
  "host_deleted",
  "host_retired",
  "host_requires_reconciliation",
  "boat_starts_disabled",
] as const;
export type WorkstationDemandReason = (typeof WORKSTATION_DEMAND_REASONS)[number];
const WORKSTATION_DEMAND_REASON_SET: ReadonlySet<string> = new Set(WORKSTATION_DEMAND_REASONS);

/**
 * Close reasons the gateway sends with code 4420 for a workstation that is not up
 * (`wsCloseForError`). 4420 is also the ordinary "this pod is asleep" code, so the reason —
 * not the code — is what tells the two apart. `host_archived` is the gateway's spelling of a
 * host that is no longer dialable.
 */
export const WORKSTATION_CLOSE_REASONS = WORKSTATION_ASLEEP_REASONS;
export const isWorkstationCloseReason = isWorkstationAsleepReason;

export interface WorkstationOperation {
  id: string;
  kind: string;
  state: string;
  phase: string;
  deadlineAt: string;
  retryAt: string | null;
  errorCode: string | null;
}

/**
 * A validated host-demand refusal: what the server said about the caller's own machine.
 *
 * The three constant fields are kept rather than collapsed away, so the value round-trips:
 * `PiPodError.detail` holds this object, and re-parsing it must recognize the same shape it
 * recognized on the wire.
 */
export interface WorkstationDemand {
  kind: "admission";
  resource: "transitions";
  unit: "count";
  reason: string;
  retryable: boolean;
  hostId?: string;
  /** Always recomputed from `hostId`; never the string the server sent. */
  statusHref?: string;
  state?: string;
  retryAfterMs?: number;
  operation?: WorkstationOperation | null;
  /**
   * The server's own sentence for this reason, when the response carried one. Not a wire
   * field of the demand: the transport copies it off the response body so an unrecognized
   * future reason can still be explained in the server's words rather than a generic
   * placeholder. Oversized or non-string values are dropped, never rejected — unlike the
   * validated fields above, nothing depends on it.
   */
  message?: string;
}

/** What `GET /v1/workstations/:hostId` answers. */
export interface WorkstationStatus {
  hostId: string;
  state?: string;
  operation: WorkstationOperation | null;
}

/**
 * One read of each own data property into a null-prototype object, so an accessor cannot
 * answer the validation and the copy differently, and an inherited property cannot answer at
 * all. Same defence the server applies on the way out.
 */
function ownDataProperties(value: object): Record<string, unknown> {
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

const ISO_INSTANT_RULE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/;

/** A canonical instant re-rendered from the parse, so no server string survives verbatim. */
function isoInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40 || !ISO_INSTANT_RULE.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** The seven fields the workstation status route exposes; all required, anything else dropped. */
export function parseWorkstationOperation(value: unknown): WorkstationOperation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = ownDataProperties(value);
  if (typeof record["id"] !== "string" || !OPERATION_ID_RULE.test(record["id"])) return null;
  if (typeof record["kind"] !== "string" || !OPERATION_KINDS.has(record["kind"])) return null;
  if (typeof record["state"] !== "string" || !OPERATION_STATES.has(record["state"])) return null;
  if (typeof record["phase"] !== "string" || !PHASE_RULE.test(record["phase"])) return null;
  const deadlineAt = isoInstant(record["deadlineAt"]);
  if (deadlineAt === null) return null;
  let retryAt: string | null = null;
  if (record["retryAt"] !== undefined && record["retryAt"] !== null) {
    retryAt = isoInstant(record["retryAt"]);
    if (retryAt === null) return null;
  }
  let errorCode: string | null = null;
  if (record["errorCode"] !== undefined && record["errorCode"] !== null) {
    if (typeof record["errorCode"] !== "string" || !ERROR_CODE_RULE.test(record["errorCode"])) return null;
    errorCode = record["errorCode"];
  }
  return { id: record["id"], kind: record["kind"], state: record["state"], phase: record["phase"], deadlineAt, retryAt, errorCode };
}

/**
 * Recognize a host-demand `detail` (server `boatHostDemandDetail`). The three constant fields
 * `kind`/`resource`/`unit` plus a string `reason` and a boolean `retryable` are what identify
 * the shape; every other field is a hint that degrades gracefully. A forged or malformed host
 * pair is dropped — never dialled, never trusted — and the demand still waits, just without a
 * status poll (the contract's "unhosted" wait: re-issue the original request on the same
 * schedule). The same holds for a malformed `state`, `retryAfterMs` or `operation`: every use
 * downstream already clamps or allowlists, so dropping the hint is safe and killing the whole
 * wait over one bad hint would strand a real workstation start on a typo.
 */
export function parseWorkstationDemand(value: unknown): WorkstationDemand | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = ownDataProperties(value);
  if (record["kind"] !== "admission") return null;
  if (record["resource"] !== "transitions" || record["unit"] !== "count") return null;
  if (typeof record["reason"] !== "string" || record["reason"].length > 64) return null;
  if (typeof record["retryable"] !== "boolean") return null;
  const demand: WorkstationDemand = {
    kind: "admission",
    resource: "transitions",
    unit: "count",
    reason: record["reason"],
    retryable: record["retryable"],
  };
  if (typeof record["hostId"] === "string" && WORKSTATION_HOST_ID_RULE.test(record["hostId"])) {
    // Recompute the link and compare rather than copying it: a path we dial is never a
    // string the response chose. On a mismatch both are dropped and the wait runs unhosted.
    if (record["statusHref"] === undefined || record["statusHref"] === workstationStatusHref(record["hostId"])) {
      demand.hostId = record["hostId"];
      demand.statusHref = workstationStatusHref(record["hostId"]);
    }
  }
  if (typeof record["state"] === "string" && WORKSTATION_STATES.has(record["state"])) {
    demand.state = record["state"];
  }
  if (typeof record["retryAfterMs"] === "number" && Number.isFinite(record["retryAfterMs"])) {
    const rounded = Math.round(record["retryAfterMs"]);
    if (rounded >= 0 && rounded <= 300_000) demand.retryAfterMs = rounded;
  }
  if (record["operation"] !== undefined) {
    if (record["operation"] === null) {
      demand.operation = null;
    } else {
      const operation = parseWorkstationOperation(record["operation"]);
      if (operation !== null) demand.operation = operation;
    }
  }
  if (typeof record["message"] === "string" && record["message"].length > 0 && record["message"].length <= 240) {
    demand.message = record["message"];
  }
  return demand;
}

export function workstationStatusHref(hostId: string): string {
  return `/v1/workstations/${encodeURIComponent(hostId)}`;
}

export function isWorkstationHostId(value: unknown): value is string {
  return typeof value === "string" && WORKSTATION_HOST_ID_RULE.test(value);
}

/** `GET /v1/workstations/:hostId`, validated the same way as the demand it corroborates. */
export function parseWorkstationStatus(value: unknown): WorkstationStatus | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = ownDataProperties(value);
  if (!isWorkstationHostId(record["hostId"])) return null;
  const status: WorkstationStatus = { hostId: record["hostId"], operation: null };
  if (record["state"] !== undefined && record["state"] !== null) {
    if (typeof record["state"] !== "string" || !WORKSTATION_STATES.has(record["state"])) return null;
    status.state = record["state"];
  }
  if (record["operation"] !== undefined && record["operation"] !== null) {
    const operation = parseWorkstationOperation(record["operation"]);
    if (operation === null) return null;
    status.operation = operation;
  }
  return status;
}

/** The demand carried by a server refusal, or null when this is not one. */
export function workstationDemandOf(error: unknown): WorkstationDemand | null {
  if (!(error instanceof PiPodError)) return null;
  if (error.status !== 503) return null;
  return parseWorkstationDemand(error.detail);
}

/**
 * Per-reason copy. Static, keyed by the validated reason — never interpolated from the
 * response — so a server sentence can never become client copy by accident.
 *
 * Every line has to hold two truths at once: this takes minutes, and nothing was lost.
 */
const WORKSTATION_COPY: Record<string, { headline: string; hint: string }> = {
  // Only the gateway spells it this way (`wsCloseForError`), for a host that cannot be
  // dialled. It means the same thing to the user as `host_stopped`: the machine is down and
  // being brought back.
  host_archived: {
    headline: "Your workstation is asleep and is being started. This may take several minutes",
    hint: "sleeping keeps every workspace on the workstation's own disk \u2014 nothing is lost and nothing needs recreating",
  },
  host_starting: {
    headline: "Your workstation is starting. This may take several minutes",
    hint: "your files are on its disk and are retained; the same command attaches once it is up",
  },
  host_stopped: {
    headline: "Your workstation is asleep and is being started. This may take several minutes",
    hint: "sleeping keeps every workspace on the workstation's own disk — nothing is lost and nothing needs recreating",
  },
  host_requires_reconciliation: {
    headline: "Your workstation is being checked after an interrupted change. This may take several minutes",
    hint: "the server settles the machine's state before using it again; your files are retained",
  },
  boat_starts_disabled: {
    headline: "Workstation starts are paused right now, so yours cannot be started",
    hint: "your files are retained on its disk — retry shortly, or ask an operator when starts resume",
  },
  host_deleted: {
    headline: "Your workstation has been deleted",
    hint: "a new workstation is created for you on the next launch; pods that lived on the old one cannot be resumed",
  },
  host_retired: {
    headline: "Your workstation has been retired",
    hint: "a new workstation is created for you on the next launch; pods that lived on the retired one cannot be resumed",
  },
};

/**
 * `Object.hasOwn`, not a plain lookup: a reason of "constructor" would otherwise read the
 * object prototype and return a function where copy belongs.
 */
function workstationCopy(reason: string): { headline: string; hint: string } | null {
  return Object.hasOwn(WORKSTATION_COPY, reason) ? WORKSTATION_COPY[reason]! : null;
}

/** Headline for a demand: the reason's static copy, else the server's own sentence. */
export function workstationHeadline(demand: WorkstationDemand): string {
  const copy = workstationCopy(demand.reason);
  if (copy) return copy.headline;
  return demand.message ?? "Your workstation is not ready yet. This may take several minutes";
}

export function workstationHint(demand: WorkstationDemand): string {
  const copy = workstationCopy(demand.reason);
  if (copy) return copy.hint;
  return demand.retryable
    ? "your files are retained on the workstation's disk; retry the same command"
    : "your files may no longer be reachable on that workstation; a new one is created on the next launch";
}

/** `4m07s`. Elapsed time is the only duration this client ever states on its own. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * The progress line for a wait in flight: elapsed time plus whatever the server actually
 * reported. No countdown, no estimate — the measured spread is 243 s to 708 s and a countdown
 * against a made-up number is a lie that gets discovered every time.
 */
export function workstationProgressLine(demand: WorkstationDemand, elapsedMs: number): string {
  const parts: string[] = [];
  if (demand.state) parts.push(demand.state);
  const operation = demand.operation;
  if (operation) {
    parts.push(operation.errorCode ? `${operation.kind}: ${operation.phase} (${operation.errorCode})` : `${operation.kind}: ${operation.phase}`);
  }
  const detail = parts.length > 0 ? ` ${color.dim(`(${parts.join(" · ")})`)}` : "";
  return `still starting your workstation — ${formatElapsed(elapsedMs)} elapsed${detail}`;
}

/** How long the client waits when the server sent no hint, and the bounds it clamps into. */
export const WORKSTATION_POLL_DEFAULT_MS = 10_000;
export const WORKSTATION_POLL_MIN_MS = 5_000;
export const WORKSTATION_POLL_MAX_MS = 60_000;
/** Consecutive unreachable-server errors on an idempotent attempt, not a workstation exit. */
export const WORKSTATION_WAIT_BUDGET_MS = 20 * 60_000;
/** Never wait past this, whatever deadline a response claims. */
export const WORKSTATION_WAIT_MAX_MS = 30 * 60_000;
export const WORKSTATION_WAIT_MIN_MS = 60_000;
/** A 700-second wait has to look alive, so progress re-renders at least this often. */
export const WORKSTATION_PROGRESS_INTERVAL_MS = 15_000;

export function workstationPollMs(demand: WorkstationDemand): number {
  const hint = demand.retryAfterMs ?? WORKSTATION_POLL_DEFAULT_MS;
  return Math.min(WORKSTATION_POLL_MAX_MS, Math.max(WORKSTATION_POLL_MIN_MS, hint));
}

/**
 * Diagnostic only. The operation deadline bounds mutation issuance on the server; it is not
 * a client exit. `withWorkstationWait` does not stop because this elapsed.
 */
export function workstationDeadlineMs(demand: WorkstationDemand, now: number): number {
  const deadlineAt = demand.operation?.deadlineAt;
  if (deadlineAt !== undefined) {
    const parsed = Date.parse(deadlineAt);
    if (Number.isFinite(parsed)) {
      return Math.min(WORKSTATION_WAIT_MAX_MS, Math.max(WORKSTATION_WAIT_MIN_MS, parsed - now));
    }
  }
  return WORKSTATION_WAIT_BUDGET_MS;
}

/** Terminal refusal (`retryable: false`), as an error with copy the user can act on. */
export function workstationTerminalError(demand: WorkstationDemand, cause?: unknown): PiPodError {
  return new PiPodError(workstationHeadline(demand), {
    hint: workstationHint(demand),
    code: demand.reason,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * A workstation refusal that did not arrive as an HTTP response — today, the gateway's close
 * 4420 with a host reason. `status` is 503 so it reads exactly like the REST refusal it
 * mirrors, and `detail` carries the demand, so one recognizer serves both transports.
 */
export class WorkstationNotReadyError extends PiPodError {
  readonly demand: WorkstationDemand;

  constructor(demand: WorkstationDemand, cause?: unknown) {
    super(workstationHeadline(demand), {
      hint: workstationHint(demand),
      status: 503,
      code: demand.reason,
      detail: demand,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "WorkstationNotReadyError";
    this.demand = demand;
  }
}

/**
 * The demand behind a gateway close. The close frame carries a reason and nothing else — no
 * host id, no operation — so the wait runs without a status poll and simply re-attaches on
 * its schedule.
 */
export function workstationCloseError(reason: string): WorkstationNotReadyError {
  return new WorkstationNotReadyError({
    kind: "admission",
    resource: "transitions",
    unit: "count",
    reason,
    retryable: true,
  });
}

/**
 * A gateway session `error` frame (or a close reason) that means the personal workstation
 * is not up. Must not treat billing 402 reasons as a wake.
 */
export function workstationErrorFromSessionMessage(
  message: Record<string, unknown>,
): WorkstationNotReadyError | null {
  const fromDetail = parseWorkstationDemand(message["detail"]);
  if (fromDetail) return new WorkstationNotReadyError(fromDetail);
  const code = typeof message["code"] === "string" ? message["code"] : "";
  if (!code || !isWorkstationCloseReason(code)) return null;
  return workstationCloseError(code);
}

/** Only `getWorkstation` is needed here, so tests inject three lines instead of a client. */
export interface WorkstationStatusSource {
  getWorkstation(hostId: string): Promise<WorkstationStatus | null>;
}

/** Start-family operations a demand can re-arm. A stop or delete is not a start cycle. */
const START_KINDS = new Set(["create", "resume", "activate"]);

/**
 * Invocation-local count of start cycles that ended stopped without the awaited request
 * succeeding. Shared across every wait in one launch so a second resolve/launch entry cannot
 * reset it.
 */
export interface WorkstationCycleTracker {
  unsuccessfulIds: string[];
}

export function createWorkstationCycleTracker(): WorkstationCycleTracker {
  return { unsuccessfulIds: [] };
}

export const WORKSTATION_START_GUARD_MESSAGE =
  "Two workstation start attempts ended without becoming usable; operator investigation is required. Your existing workstation has not been replaced.";

function startOperationId(demand: WorkstationDemand): string | null {
  const operation = demand.operation;
  if (!operation || !START_KINDS.has(operation.kind)) return null;
  return operation.id;
}

function noteUnsuccessfulCycle(tracker: WorkstationCycleTracker, operationId: string): number {
  if (!tracker.unsuccessfulIds.includes(operationId)) tracker.unsuccessfulIds.push(operationId);
  return tracker.unsuccessfulIds.length;
}

export interface WorkstationWaitOptions {
  /** True once the user has interrupted; checked before every sleep and every attempt. */
  cancelled?: (() => boolean) | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Where progress goes; defaults to the `[workstation]` step line. */
  progress?: ((line: string) => void) | undefined;
  progressIntervalMs?: number | undefined;
  /**
   * The refusal that already happened, for a caller holding one. Without it the routine has
   * to make the failing call again just to learn what the caller already knows.
   */
  from?: WorkstationDemand | undefined;
  /**
   * Shared across waits in one launch. Absent means this wait has its own tracker, which is
   * enough for a single attach but not for resolve-then-launch.
   */
  cycles?: WorkstationCycleTracker | undefined;
  /**
   * False for a mutating launch POST: a timeout is not proof the request did not commit, so
   * the waiter must not issue it again. Typed workstation 503s are still retried.
   */
  replayTransport?: boolean | undefined;
  /**
   * How long consecutive unreachable-server errors may be retried on an idempotent attempt.
   * This is not a workstation deadline and does not ask the user to re-run.
   */
  transportGraceMs?: number | undefined;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt`, and if the server refuses because the caller's workstation is not up, wait
 * for it and run the SAME request again.
 *
 * A typed workstation 503 is raised before a pod row exists, so asking again does not create
 * a second pod. A mutating launch whose reply was lost is different: the waiter does not
 * reissue that POST (`replayTransport: false`); the caller decides from an identified pod,
 * never from an empty list.
 *
 * The operation deadline is not an exit. While the server still reports the start, this wait
 * continues. It stops on cancel, a terminal refusal, two observed start cycles that ended
 * stopped without success, or — for an idempotent attempt only — a server that stays
 * unreachable past the transport grace. It never tells the user to come back and re-run.
 *
 * Readiness is the server's to declare. A status poll that says `running` starts the next
 * attempt immediately, but only a successful attempt ends the wait.
 */
export async function withWorkstationWait<T>(
  source: WorkstationStatusSource,
  attempt: () => Promise<T>,
  opts: WorkstationWaitOptions = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const progress = opts.progress ?? ((line: string) => step("workstation", line));
  const progressIntervalMs = opts.progressIntervalMs ?? WORKSTATION_PROGRESS_INTERVAL_MS;
  const cancelled = opts.cancelled;
  const tracker = opts.cycles ?? createWorkstationCycleTracker();
  const replayTransport = opts.replayTransport !== false;
  const transportGraceMs = opts.transportGraceMs ?? WORKSTATION_WAIT_BUDGET_MS;

  const checkCancelled = (demand: WorkstationDemand | null): void => {
    if (!cancelled?.()) return;
    throw new CancelledError(
      demand
        ? "interrupted — your workstation keeps starting on the server and your files are retained; a later launch attaches to the same workstation"
        : "interrupted",
    );
  };

  let demand: WorkstationDemand | null = opts.from ?? null;
  // A caller that already holds the refusal can be cancelled before any retry. The discovering
  // attempt itself still runs: an interrupt that arrives with the refusal has to be told that
  // the workstation keeps starting, and that attempt is what learned the demand.
  if (demand) checkCancelled(demand);
  if (demand === null) {
    try {
      return await attempt();
    } catch (error) {
      demand = workstationDemandOf(error);
      if (!demand) throw error;
      if (!demand.retryable) throw workstationTerminalError(demand, error);
      checkCancelled(demand);
    }
  } else if (!demand.retryable) {
    throw workstationTerminalError(demand);
  }

  const startedAt = now();
  progress(`${workstationHeadline(demand)} — ${workstationHint(demand)}`);
  let lastProgressAt = startedAt;
  let observedStartId = startOperationId(demand);
  let transportSince: number | null = null;

  for (;;) {
    checkCancelled(demand);
    const waitMs = workstationPollMs(demand);
    await sleep(waitMs);
    checkCancelled(demand);

    if (demand.hostId) {
      const status = await pollStatus(source, demand.hostId);
      checkCancelled(demand);
      if (status && status.hostId === demand.hostId) {
        const operation = status.operation;
        if (operation && START_KINDS.has(operation.kind)) {
          // A different id is not proof the previous cycle failed.
          observedStartId = operation.id;
          demand = {
            ...demand,
            ...(status.state !== undefined ? { state: status.state } : {}),
            operation,
          };
        } else if (operation === null && status.state === "stopped" && observedStartId) {
          const counted = noteUnsuccessfulCycle(tracker, observedStartId);
          observedStartId = null;
          demand = { ...demand, state: "stopped", operation: null };
          if (counted >= 2) {
            throw new PiPodError(WORKSTATION_START_GUARD_MESSAGE, {
              code: "workstation_start_guard",
              transient: false,
            });
          }
        } else {
          demand = {
            ...demand,
            ...(status.state !== undefined ? { state: status.state } : {}),
            operation,
          };
        }
      }
    }

    if (now() - lastProgressAt >= progressIntervalMs) {
      lastProgressAt = now();
      progress(workstationProgressLine(demand, now() - startedAt));
    }

    checkCancelled(demand);
    try {
      return await attempt();
    } catch (error) {
      checkCancelled(demand);
      const next = workstationDemandOf(error);
      if (next) {
        if (!next.retryable) throw workstationTerminalError(next, error);
        transportSince = null;
        const nextStart = startOperationId(next);
        if (nextStart) observedStartId = nextStart;
        demand = next;
      } else if (replayTransport && error instanceof PiPodError && error.transient && error.status === undefined) {
        transportSince ??= now();
        if (now() - transportSince >= transportGraceMs) throw error;
        progress(`the server did not answer in time — retrying on the wait schedule (${formatElapsed(now() - startedAt)} elapsed)`);
        lastProgressAt = now();
      } else {
        throw error;
      }
    }
  }
}

/** A status poll is progress reporting, not a gate: a failed poll never ends the wait. */
async function pollStatus(source: WorkstationStatusSource, hostId: string): Promise<WorkstationStatus | null> {
  try {
    return await source.getWorkstation(hostId);
  } catch (error) {
    debug(`workstation status poll failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
