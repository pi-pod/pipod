import { audit } from "../audit.js";
import { tx } from "../db/index.js";
import { acquireQuotaLocks } from "./concurrency.js";
import { HttpError } from "../httperrors.js";
import { observePodLaunch } from "../metrics.js";
import { truncate } from "../push/copy.js";
import {
  FLEET_UNAVAILABLE_CODE,
  FLEET_UNAVAILABLE_MESSAGE,
  boundStaticText,
  describeAdmissionRefusal,
  renderAdmissionMessage,
  sanitizeErrorMessage,
  sanitizeFailureMessage,
} from "../safe-errors.js";
import type { ResolvedConfigReport } from "./types.js";

/**
 * Typed launch-failure codes that survive the fail-closed leakage boundary.
 *
 * Every other provisioning failure stays exactly as before (one generic
 * sanitized string). Only these allowlisted codes are prefixed onto
 * `state_reason` as `launch_failed:<code>: <human message>`, so clients can
 * distinguish a typed capacity outcome from an opaque failure without any
 * provider prose crossing the boundary. The code allowlist is closed: an
 * unrecognized code renders no prefix at all.
 */
export const CAPACITY_WAIT_EXPIRED_CODE = "capacity_wait_expired";
export const CAPACITY_WAIT_ORPHANED_CODE = "capacity_wait_orphaned";
/**
 * A host refused admission and said why in validated enums and numbers. The
 * message under this code is composed by {@link describeAdmissionRefusal} from
 * static copy plus that detail, so the recorder keeps it verbatim instead of
 * genericizing a launch the host already explained.
 */
export const ADMISSION_DENIED_CODE = "admission_denied";
const LAUNCH_FAILED_PREFIX = "launch_failed:";
const LAUNCH_FAILURE_CODES = new Set([
  CAPACITY_WAIT_EXPIRED_CODE,
  CAPACITY_WAIT_ORPHANED_CODE,
  ADMISSION_DENIED_CODE,
]);

/** Prefix a sanitized human message with a typed code (no-op for unknown codes). */
export function formatLaunchFailure(code: string | null | undefined, message: string): string {
  if (typeof code !== "string" || !LAUNCH_FAILURE_CODES.has(code)) return message;
  return `${LAUNCH_FAILED_PREFIX}${code}: ${message}`;
}

/** Recover the typed code from a `state_reason` written by {@link formatLaunchFailure}. */
export function parseLaunchFailureCode(stateReason: string | null | undefined): string | null {
  if (typeof stateReason !== "string" || !stateReason.startsWith(LAUNCH_FAILED_PREFIX)) return null;
  const code = stateReason.slice(LAUNCH_FAILED_PREFIX.length).split(":", 1)[0]?.trim() ?? "";
  return LAUNCH_FAILURE_CODES.has(code) ? code : null;
}

/**
 * What a background provisioning throw becomes at the 500 boundary: the string
 * for the log, `report.warnings`, `state_reason` and the push body, plus the
 * typed code the recorder needs to keep that string instead of genericizing it.
 *
 * A host that refused admission already answered in validated enums and numbers
 * (`{kind: "admission", reason: "memory_capacity", required, available, …}`),
 * and dropping that on the floor is what left operators reading `operation
 * failed (507)` for a pod that simply asked for more memory than the host had.
 * Composition still happens entirely inside the leakage boundary: static copy
 * plus the sanitized detail, never the throw's message, hint, or body. Any
 * other failure — including a malformed or forged `details` — is byte-identical
 * to before: the generic sanitized message and no code.
 */
export function describeLaunchFailure(error: unknown): { message: string; code: string | null } {
  const admission = describeAdmissionRefusal(error);
  if (admission !== null) return { message: admission, code: ADMISSION_DENIED_CODE };
  return { message: sanitizeFailureMessage(error), code: null };
}

/** Structured terminal detail a capacity-wait expiry throw carries (never crosses the boundary raw). */
export interface CapacityWaitTerminalDetail {
  code: typeof CAPACITY_WAIT_EXPIRED_CODE;
  reason: string;
  required?: number;
  available?: number;
  unit?: string;
  waitedSeconds: number;
}

function isShortSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Recognize the waiter's own final-deadline throw at the provisioning 500
 * boundary. Strict shape check (503 + allowlisted code + slug reason +
 * validated numbers): anything else stays on the generic sanitized path.
 */
export function capacityWaitTerminalDetail(error: unknown): CapacityWaitTerminalDetail | null {
  if (!(error instanceof HttpError) || error.statusCode !== 503) return null;
  const detail = error.detail;
  if (detail === null || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  if (record["code"] !== CAPACITY_WAIT_EXPIRED_CODE) return null;
  if (!isShortSlug(record["reason"])) return null;
  const waitedSeconds = record["waitedSeconds"];
  if (typeof waitedSeconds !== "number" || !Number.isFinite(waitedSeconds) || waitedSeconds < 0) {
    return null;
  }
  const out: CapacityWaitTerminalDetail = {
    code: CAPACITY_WAIT_EXPIRED_CODE,
    reason: record["reason"],
    waitedSeconds: Math.round(waitedSeconds),
  };
  for (const key of ["required", "available"] as const) {
    if (record[key] !== undefined) {
      if (!isFiniteNonNegativeNumber(record[key])) return null;
      out[key] = record[key];
    }
  }
  if (record["unit"] !== undefined) {
    if (!isShortSlug(record["unit"])) return null;
    out.unit = record["unit"];
  }
  return out;
}

/**
 * Render the client/row copy for a typed wait terminal from validated fields
 * only (static copy + allowlisted reason + finite numbers). Never takes
 * provider prose: the admission sentence renders from the reason enum, and
 * unknown reasons fall back to the generic capacity sentence.
 */
export function renderCapacityWaitTerminal(detail: {
  reason: string;
  waitedSeconds: number;
  outcome?: "expired" | "orphaned";
}): string {
  // A wait that ended while the fleet was unreachable says so: the fleet
  // sentence is static copy, never the outage's free-form message.
  const sentence =
    detail.reason === FLEET_UNAVAILABLE_CODE
      ? FLEET_UNAVAILABLE_MESSAGE
      : (renderAdmissionMessage({ kind: "admission", reason: detail.reason }) ??
        "the fleet is still at capacity; retry shortly");
  return boundStaticText(
    `capacity wait ${detail.outcome ?? "expired"}: ${sentence} (waited ${Math.max(0, Math.round(detail.waitedSeconds))}s for ${detail.reason})`,
    500,
  );
}

/**
 * Preserve provider-backed failures for recovery, but reap a launch that never acquired compute.
 * The gone row remains addressable by id long enough for launch polling to show the reason while
 * normal pod listing omits it, and audit remains the durable operator record.
 */
export async function recordProvisioningFailure(args: {
  podId: string;
  orgId: string;
  userId: string;
  report: ResolvedConfigReport;
  message: string;
  /**
   * Typed outcome (allowlisted; see {@link formatLaunchFailure}). Only
   * capacity-wait terminal paths pass one; every other caller leaves it
   * unset and the row is byte-identical to before.
   */
  code?: string | null;
}): Promise<"gone" | "error" | "recovery_required" | null> {
  // Keep provider prose out of durable state. Ambiguous create outcomes get
  // fixed copy and remain active/visible; only an unsent or provider-confirmed
  // safe refusal may be archived as gone.
  const safeReason = truncate(
    formatLaunchFailure(
      args.code,
      args.code && LAUNCH_FAILURE_CODES.has(args.code)
        ? boundStaticText(args.message, 400)
        : sanitizeErrorMessage(args.message),
    ),
    500,
  );
  const recoveryReason = "launch outcome remains unresolved on its original host; no replacement was attempted";
  const outcome = await tx(async (client) => {
    await acquireQuotaLocks(client, args.orgId, args.userId);
    const attempts = await client.query<{
      id: string;
      phase: string;
      sandbox_id: string | null;
      owner_token: string | null;
      recovery_token: string | null;
    }>(
      `SELECT id, phase, sandbox_id, owner_token, recovery_token
         FROM pod_create_attempts WHERE pod_id=$1
        ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`,
      [args.podId],
    );
    const attempt = attempts.rows[0];
    const found = await client.query<{
      provider: string;
      provider_state: string;
      provider_sandbox_id: string | null;
    }>(
      `SELECT provider, provider_state, provider_sandbox_id
         FROM pods WHERE id=$1 AND org_id=$2 AND state='active' FOR UPDATE`,
      [args.podId, args.orgId],
    );
    const pod = found.rows[0];
    if (!pod || !["preparing_image", "provisioning", "starting"].includes(pod.provider_state)) return null;
    let unresolved = false;
    let sandboxId = pod.provider_sandbox_id;
    if (attempt) {
      if (attempt.phase === "prepared") {
        await client.query(
          `UPDATE pod_create_attempts SET phase='aborted_unsent', reason_code='owner_failed_before_dispatch',
             owner_token=NULL, owner_lease_until=NULL, next_observe_at=NULL, finished_at=now(), updated_at=now()
            WHERE id=$1 AND phase='prepared' AND recovery_token IS NULL`,
          [attempt.id],
        );
      } else if (attempt.phase === "failed_safe" || attempt.phase === "aborted_unsent" || attempt.phase === "deleted") {
        // The original host affirmatively reported no surviving resource.
      } else if (attempt.phase === "ready") {
        return null;
      } else {
        unresolved = true;
        sandboxId = sandboxId ?? attempt.sandbox_id;
        if (attempt.phase === "sandbox_known") {
          await client.query(
            `UPDATE pod_create_attempts SET phase='initialization_interrupted',
               reason_code='initialization_interrupted', owner_token=NULL,
               owner_lease_until=NULL, next_observe_at=NULL, updated_at=now()
              WHERE id=$1 AND phase='sandbox_known' AND recovery_token IS NULL`,
            [attempt.id],
          );
        } else if (attempt.phase === "dispatching") {
          await client.query(
            `UPDATE pod_create_attempts SET phase='unknown', reason_code='original_outcome_unknown',
               owner_token=NULL, owner_lease_until=NULL, next_observe_at=now(), updated_at=now()
              WHERE id=$1 AND phase='dispatching' AND recovery_token IS NULL`,
            [attempt.id],
          );
        } else if (attempt.phase === "unknown") {
          await client.query(
            `UPDATE pod_create_attempts SET owner_token=NULL, owner_lease_until=NULL,
               next_observe_at=COALESCE(next_observe_at, now()), updated_at=now()
              WHERE id=$1 AND phase='unknown' AND recovery_token IS NULL`,
            [attempt.id],
          );
        }
      }
    }

    const reason = unresolved ? recoveryReason : safeReason;
    const state = unresolved || sandboxId
      ? "error"
      : "gone";
    const failed = await client.query<{ provider_state: "gone" | "error"; provider: string }>(
      `UPDATE pods SET
         provider_sandbox_id = COALESCE(provider_sandbox_id, $4),
         provider_state = $5,
         state = CASE WHEN $5 = 'gone' THEN 'archived' ELSE state END,
         archived_at = CASE WHEN $5 = 'gone' THEN COALESCE(archived_at, now()) ELSE archived_at END,
         provider_state_changed_at = now(), state_reason = $3, resolved_config = $2,
         reaped_at = CASE WHEN $5 = 'gone' THEN now() ELSE reaped_at END,
         updated_at = now()
       WHERE id = $1 AND org_id=$6 AND state = 'active'
         AND provider_state IN ('preparing_image','provisioning','starting')
       RETURNING provider_state, provider`,
      [args.podId, JSON.stringify(args.report), reason, sandboxId, state, args.orgId],
    );
    const row = failed.rows[0];
    return row ? { state: row.provider_state, provider: row.provider, unresolved } : null;
  });
  if (!outcome) return null;
  observePodLaunch(outcome.provider, "failed");

  await audit({
    orgId: args.orgId,
    actorId: args.userId,
    action: outcome.unresolved ? "pod.launch_recovery_required" : "pod.launch_failed",
    targetType: "pod",
    targetId: args.podId,
    detail: outcome.unresolved
      ? { reason: "original_outcome_unknown", beforeSandbox: !outcome.state || outcome.state === "gone" }
      : { reason: safeReason, beforeSandbox: outcome.state === "gone" },
  });
  return outcome.unresolved ? "recovery_required" : outcome.state;
}
