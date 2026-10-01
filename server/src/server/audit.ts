/**
 * Low-volume critical actions only: launches, deletes, secret and policy writes — what an
 * auditor asks about months later. Identity events (login, logout, token issuance) live in
 * Zitadel and are not copied here; neither is per-message or per-poll traffic.
 */
import { getPool, type Queryable } from "./db/index.js";
import { uuidv7 } from "./ids.js";

export interface AuditEntry {
  orgId: string;
  /** Null for system actions (workers, reconciler). */
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Phase 4: accept the ambient transaction so a mutation and its audit row commit together.
 * Existing single-argument callers are unchanged — they use the pool — while transactional
 * writers (secret rotation, credential refresh) pass their `tx` client. The secrets
 * store/routes integration is a separate change owned elsewhere; this only opens the seam.
 */
function auditParams(entry: AuditEntry, id: string): unknown[] {
  return [
    id,
    entry.orgId,
    entry.actorId,
    entry.action,
    entry.targetType ?? null,
    entry.targetId ?? null,
    JSON.stringify(entry.detail ?? {}),
  ];
}

export async function audit(entry: AuditEntry, client?: Queryable): Promise<void> {
  const run = client ?? getPool();
  const id=uuidv7();
  await run.query(
    `INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    auditParams(entry,id),
  );
}

/**
 * Same-client fail-closed variant for mutations whose commit requires exactly
 * one normal audit row. In particular, a BEFORE trigger returning NULL yields
 * zero RETURNING rows and aborts the surrounding transaction.
 */
export async function auditStrict(entry: AuditEntry, client: Queryable): Promise<string> {
  const id=uuidv7();
  const result=await client.query<{id:string}>(
    `INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    auditParams(entry,id),
  );
  if ((result.rowCount ?? 0)!==1 || result.rows.length!==1 || result.rows[0]?.id!==id) {
    throw new Error("audit insert did not persist exactly one row");
  }
  return id;
}
