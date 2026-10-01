import { randomUUID } from "node:crypto";
import type pg from "pg";
import { query, tx } from "../db/index.js";
import { conflict, notFound } from "../httperrors.js";

/** Coordination lease. The generation fences late pod inserts after takeover. */
export const LAUNCH_OPERATION_LEASE_SECONDS = 300;

export type LaunchOperationState = "pending" | "waiting" | "admitted" | "rejected" | "unknown";

export interface LaunchOperationRow {
  org_id: string;
  user_id: string;
  operation_id: string;
  template_id: string | null;
  state: LaunchOperationState;
  owner_generation: number;
  owner_token: string | null;
  owner_lease_until: string | Date | null;
  pod_id: string | null;
  error_status: number | null;
  error_code: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface LaunchOperationClaim {
  orgId: string;
  userId: string;
  operationId: string;
  templateId: string | null;
  ownerGeneration: number;
  ownerToken: string;
}

export type LaunchOperationReservation =
  | { kind: "owner"; claim: LaunchOperationClaim }
  | { kind: "existing"; operation: LaunchOperationRow };

function claimFrom(row: LaunchOperationRow): LaunchOperationClaim {
  if (!row.owner_token) throw new Error("launch operation owner token missing");
  return {
    orgId: row.org_id,
    userId: row.user_id,
    operationId: row.operation_id,
    templateId: row.template_id,
    ownerGeneration: Number(row.owner_generation),
    ownerToken: row.owner_token,
  };
}

/**
 * Reserve one authenticated native launch. Same-ID retries either observe the
 * current owner/result or take a new fenced generation after a refusal, unknown
 * outcome, or expired owner lease.
 */
export async function reserveLaunchOperation(args: {
  orgId: string;
  userId: string;
  operationId: string;
  templateId: string | null;
}): Promise<LaunchOperationReservation> {
  return tx(async (client) => {
    const ownerToken = randomUUID();
    const inserted = await client.query<LaunchOperationRow>(
      `INSERT INTO pod_launch_operations
         (org_id, user_id, operation_id, template_id, state,
          owner_generation, owner_token, owner_lease_until)
       VALUES ($1, $2, $3, $4, 'pending', 1, $5,
               now() + make_interval(secs => $6))
       ON CONFLICT (org_id, user_id, operation_id) DO NOTHING
       RETURNING *`,
      [args.orgId, args.userId, args.operationId, args.templateId, ownerToken,
       LAUNCH_OPERATION_LEASE_SECONDS],
    );
    if (inserted.rows[0]) return { kind: "owner", claim: claimFrom(inserted.rows[0]) };

    const found = await client.query<LaunchOperationRow & { owner_active: boolean }>(
      `SELECT *, (owner_lease_until > now()) AS owner_active
       FROM pod_launch_operations
       WHERE org_id = $1 AND user_id = $2 AND operation_id = $3
       FOR UPDATE`,
      [args.orgId, args.userId, args.operationId],
    );
    const row = found.rows[0];
    if (!row) throw conflict("launch operation could not be reserved; check its status");
    if (row.template_id !== args.templateId) {
      throw conflict("launch operation id was already used for a different environment");
    }
    if (row.state === "admitted" || row.state === "rejected"
        || (row.state === "pending" && row.owner_active)) {
      return { kind: "existing", operation: row };
    }

    const nextGeneration = Number(row.owner_generation) + 1;
    const claimed = await client.query<LaunchOperationRow>(
      `UPDATE pod_launch_operations
          SET state = 'pending', owner_generation = $4, owner_token = $5,
              owner_lease_until = now() + make_interval(secs => $6),
              error_status = NULL, error_code = NULL, updated_at = now()
        WHERE org_id = $1 AND user_id = $2 AND operation_id = $3
       RETURNING *`,
      [args.orgId, args.userId, args.operationId, nextGeneration, ownerToken,
       LAUNCH_OPERATION_LEASE_SECONDS],
    );
    const claimedRow = claimed.rows[0];
    if (!claimedRow) throw conflict("launch operation ownership changed; check its status");
    return { kind: "owner", claim: claimFrom(claimedRow) };
  });
}

/** Commit launch identity in the same transaction as the pod row. */
export async function admitLaunchOperationTx(
  client: pg.PoolClient,
  claim: LaunchOperationClaim,
  podId: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE pod_launch_operations
        SET state = 'admitted', pod_id = $5, owner_token = NULL,
            owner_lease_until = NULL, error_status = NULL, error_code = NULL,
            updated_at = now()
      WHERE org_id = $1 AND user_id = $2 AND operation_id = $3
        AND owner_generation = $4 AND owner_token = $6 AND state = 'pending'`,
    [claim.orgId, claim.userId, claim.operationId, claim.ownerGeneration, podId, claim.ownerToken],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw conflict("launch operation ownership changed before admission");
  }
}

/** Finalize only the exact request generation that currently owns the attempt. */
export async function finishLaunchOperation(
  claim: LaunchOperationClaim,
  outcome: { state: "waiting" | "rejected" | "unknown"; status?: number; code?: string },
): Promise<void> {
  await query(
    `UPDATE pod_launch_operations
        SET state = $5, owner_token = NULL, owner_lease_until = NULL,
            error_status = $6, error_code = $7, updated_at = now()
      WHERE org_id = $1 AND user_id = $2 AND operation_id = $3
        AND owner_generation = $4 AND owner_token = $8 AND state = 'pending'`,
    [claim.orgId, claim.userId, claim.operationId, claim.ownerGeneration,
     outcome.state, outcome.status ?? null, outcome.code ?? null, claim.ownerToken],
  );
}

export async function getLaunchOperation(args: {
  orgId: string;
  userId: string;
  operationId: string;
}): Promise<LaunchOperationRow> {
  const result = await query<LaunchOperationRow>(
    `SELECT * FROM pod_launch_operations
     WHERE org_id = $1 AND user_id = $2 AND operation_id = $3`,
    [args.orgId, args.userId, args.operationId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("launch operation not found");
  return row;
}
