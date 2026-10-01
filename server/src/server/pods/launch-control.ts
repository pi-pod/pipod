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

const ALWAYS_HELD_PHASES = [
  "unknown",
  "initialization_interrupted",
  "legacy_unresolved",
  "delete_pending",
] as const;

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

/** A user's unresolved create holds the owner across orgs and client operation ids. */
export async function assertNoLaunchRecoveryHold(
  db: Queryable | undefined,
  userId: string,
  ignoreAttemptId?: string,
): Promise<void> {
  const result = await select<{ pod_id: string; phase: string }>(
    db,
    `SELECT pod_id, phase
       FROM pod_create_attempts
      WHERE user_id = $1
        AND ($2::uuid IS NULL OR id <> $2::uuid)
        AND (
          phase = ANY($3::text[])
          OR (phase IN ('dispatching','sandbox_known') AND (
            owner_token IS NULL OR owner_instance_id IS NULL OR owner_lease_until IS NULL
            OR owner_lease_until <= clock_timestamp() OR recovery_token IS NOT NULL
          ))
        )
      ORDER BY created_at ASC
      LIMIT 1`,
    [userId, ignoreAttemptId ?? null, [...ALWAYS_HELD_PHASES]],
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
