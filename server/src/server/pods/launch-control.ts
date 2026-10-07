import type pg from "pg";
import type { Queryable } from "../db/index.js";
import { query } from "../db/index.js";
import { conflict, launchAdmissionHeldError, serviceUnavailable } from "../httperrors.js";

export const LAUNCH_RECOVERY_PROTOCOL_VERSION = 1;

export interface LaunchControlRow {
  mode: "held" | "open";
  epoch: string;
  required_protocol: number;
  cutover_id: string;
  changed_at: string;
  actor: string;
  reason_code: string;
}

/**
 * Account-wide fencing is for unaccounted creates, not pod-local initialization errors.
 * A failed initializer retains its original sandbox and quota charge. Once the trusted
 * journal and pod agree on that sandbox, another launch cannot duplicate its allocation.
 * Share this predicate with the final dispatch fence so admission and dispatch agree.
 */
export function launchRecoveryHoldSql(alias: "a" | "other"): string {
  return `(
    ${alias}.phase IN ('unknown','legacy_unresolved','delete_pending')
    OR (${alias}.phase = 'initialization_interrupted' AND NOT EXISTS (
      SELECT 1 FROM pods AS accounted
       WHERE accounted.id = ${alias}.pod_id
         AND accounted.org_id = ${alias}.org_id
         AND accounted.user_id = ${alias}.user_id
         AND accounted.provider = ${alias}.provider
         AND accounted.provider_sandbox_id = ${alias}.sandbox_id
    ))
    OR (${alias}.phase IN ('dispatching','sandbox_known') AND (
      ${alias}.owner_token IS NULL OR ${alias}.owner_instance_id IS NULL
      OR ${alias}.owner_lease_until IS NULL
      OR ${alias}.owner_lease_until <= clock_timestamp()
      OR ${alias}.recovery_token IS NOT NULL
    ))
  )`;
}

async function select<R extends pg.QueryResultRow>(db: Queryable | undefined, text: string, params: unknown[] = []) {
  return db ? db.query<R>(text, params) : query<R>(text, params);
}

/** Read the durable global admission mode. A missing row/schema is a closed gate. */
export async function readLaunchControl(db?: Queryable): Promise<LaunchControlRow> {
  const result = await select<LaunchControlRow>(
    db,
    `SELECT mode, epoch, required_protocol, cutover_id, changed_at, actor, reason_code
       FROM launch_recovery_control WHERE singleton = true`,
  );
  const row = result.rows[0];
  if (!row || (row.mode !== "held" && row.mode !== "open")) {
    throw serviceUnavailable("launch admission is unavailable", { code: "launch_control_unavailable" });
  }
  return row;
}

/** Fail closed while the global cutover gate is held or the binary is too old. */
export async function launchGateIsOpen(): Promise<boolean> {
  try {
    const row = await readLaunchControl();
    return row.mode === "open" && row.required_protocol <= LAUNCH_RECOVERY_PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

export async function assertLaunchGateOpen(db?: Queryable): Promise<LaunchControlRow> {
  const row = await readLaunchControl(db);
  if (row.mode !== "open" || row.required_protocol > LAUNCH_RECOVERY_PROTOCOL_VERSION) {
    throw launchAdmissionHeldError();
  }
  return row;
}

/** An unaccounted create holds its owner across orgs and client operation ids. */
export async function assertNoLaunchRecoveryHold(
  db: Queryable | undefined,
  userId: string,
  ignoreAttemptId?: string,
): Promise<void> {
  const result = await select<{ pod_id: string; phase: string }>(
    db,
    `SELECT a.pod_id, a.phase
       FROM pod_create_attempts AS a
      WHERE a.user_id = $1
        AND ($2::uuid IS NULL OR a.id <> $2::uuid)
        AND ${launchRecoveryHoldSql("a")}
      ORDER BY a.created_at ASC
      LIMIT 1`,
    [userId, ignoreAttemptId ?? null],
  );
  if (result.rows[0]) {
    throw conflict("an earlier launch still needs recovery before this account can launch again", {
      code: "launch_recovery_required",
    });
  }
}

export async function assertLaunchAllowed(
  db: Queryable | undefined,
  userId: string,
  ignoreAttemptId?: string,
): Promise<LaunchControlRow> {
  const gate = await assertLaunchGateOpen(db);
  await assertNoLaunchRecoveryHold(db, userId, ignoreAttemptId);
  return gate;
}

/** Operator-only state transition; production CLI supplies its actor and verified source SHA. */
export async function transitionLaunchControl(args: {
  mode: "held" | "open";
  expectedEpoch: number;
  protocolVersion: number;
  sourceSha: string | null;
  actor: string;
  reasonCode: string;
}): Promise<{ mode: "held" | "open"; epoch: string; changed_at: string }> {
  const result = await query<{ mode: "held" | "open"; epoch: string; changed_at: string }>(
    `SELECT * FROM set_launch_recovery_mode($1, $2, $3, $4, $5, $6)`,
    [
      args.mode,
      args.expectedEpoch,
      args.protocolVersion,
      args.sourceSha,
      args.actor,
      args.reasonCode,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("launch recovery transition returned no state");
  return row;
}
