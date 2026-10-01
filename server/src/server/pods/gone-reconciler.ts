/**
 * Failed-launch row reconciliation (gate-3 canary follow-up).
 *
 * Failed launches that never acquired compute converge to
 * `provider_state='gone'` with no `provider_sandbox_id`. New failures are
 * archived atomically by the failure recorder (`recordProvisioningFailure`)
 * and the abandoned-provisioning sweep, but rows that failed before that
 * convergence (and user-abandoned launches) can still sit at
 * `state='active'` — invisible to every listing (`listPods` excludes
 * `provider_state='gone'`) yet counted as active. They accumulate forever:
 * the CLI cannot list, archive, or gc them (`no pod matches`).
 *
 * Invariant (§1.3(1)): this never deletes anything, and never touches a row
 * that has (or may have) a workspace. Only rows with NO `provider_sandbox_id`
 * are eligible; any row naming a provider sandbox is REFUSED for operator
 * adjudication (confirm the provider 404s before touching it). The archive
 * write re-asserts the full eligible tuple, so a row that gained a sandbox
 * between inventory and apply is left alone.
 */
import { audit } from "../audit.js";
import { query } from "../db/index.js";

export interface GoneLaunchRow {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  provider: string;
  state: string;
  provider_state: string;
  provider_sandbox_id: string | null;
  has_unresolved_create_attempt: boolean;
  state_reason: string | null;
  created_at: string;
  provider_state_changed_at: string;
}

export type GoneRowDecision = "archive" | "refuse" | "skip";

export interface GoneRowPlan {
  row: GoneLaunchRow;
  decision: GoneRowDecision;
  detail: string;
}

export interface GoneReconcileResult {
  plans: GoneRowPlan[];
  archived: string[];
  refused: string[];
  skipped: string[];
  failed: Array<{ podId: string; reason: string }>;
}

/** Every `provider_state='gone'` row, oldest first — the full review surface. */
export async function findGoneRows(): Promise<GoneLaunchRow[]> {
  const res = await query<GoneLaunchRow>(
    `SELECT id, org_id, user_id, name, provider, state, provider_state, provider_sandbox_id,
            state_reason, created_at, provider_state_changed_at,
            EXISTS (SELECT 1 FROM pod_create_attempts AS a WHERE a.pod_id=pods.id
              AND a.phase IN ('prepared','dispatching','unknown','sandbox_known',
                              'initialization_interrupted','legacy_unresolved','delete_pending'))
              AS has_unresolved_create_attempt
       FROM pods WHERE provider_state = 'gone' ORDER BY created_at ASC`,
  );
  return res.rows;
}

/**
 * Pure classification (unit-testable without a database): only
 * active + gone + no-sandbox-id rows are eligible. Everything with a
 * provider sandbox id is refused — a workspace may exist, and only a
 * provider-404 confirmation (outside this command) clears it.
 */
export function classifyGoneRow(row: GoneLaunchRow): GoneRowPlan {
  if (row.provider_state !== "gone" || row.state !== "active") {
    return { row, decision: "skip", detail: `state=${row.state} provider_state=${row.provider_state}; already terminal` };
  }
  if (row.has_unresolved_create_attempt) {
    return {
      row,
      decision: "refuse",
      detail: "a durable create-attempt recovery hold exists; observe the original host before changing state",
    };
  }
  if (row.provider_sandbox_id !== null) {
    return {
      row,
      decision: "refuse",
      detail:
        `names provider sandbox ${row.provider_sandbox_id}: a workspace may exist — ` +
        "confirm the provider 404s for it before any state change",
    };
  }
  return {
    row,
    decision: "archive",
    detail: "never acquired compute (no provider sandbox id): safe to converge to archived",
  };
}

/**
 * Converge eligible rows to `archived` (dry run by default). Archiving keeps
 * the row addressable by id (launch polling, DELETE route) while removing it
 * from the active set it should never have lingered in. The UPDATE
 * re-asserts the eligible tuple; a concurrent provisioning write that
 * claimed the row first wins and this reports the row as skipped.
 */
export async function reconcileGoneRows(args: {
  dryRun: boolean;
  actorId: string | null;
  log: { info: (m: string) => void; warn: (m: string) => void };
}): Promise<GoneReconcileResult> {
  const result: GoneReconcileResult = { plans: [], archived: [], refused: [], skipped: [], failed: [] };
  const rows = await findGoneRows();
  for (const row of rows) {
    const plan = classifyGoneRow(row);
    result.plans.push(plan);
    if (plan.decision === "refuse") {
      result.refused.push(row.id);
      args.log.warn(`refusing ${row.id} (${row.name}): ${plan.detail}`);
      continue;
    }
    if (plan.decision === "skip") {
      result.skipped.push(row.id);
      continue;
    }
    if (args.dryRun) continue;
    try {
      const updated = await query(
        `UPDATE pods SET state = 'archived', archived_at = COALESCE(archived_at, now()), updated_at = now()
         WHERE id = $1 AND state = 'active' AND provider_state = 'gone' AND provider_sandbox_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM pod_create_attempts AS a WHERE a.pod_id=pods.id
             AND a.phase IN ('prepared','dispatching','unknown','sandbox_known',
                             'initialization_interrupted','legacy_unresolved','delete_pending'))
         RETURNING id`,
        [row.id],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        result.skipped.push(row.id);
        args.log.warn(`skipped ${row.id} (${row.name}): row changed underfoot; re-run to re-read it`);
        continue;
      }
      await audit({
        orgId: row.org_id,
        actorId: args.actorId,
        action: "pod.reconcile_gone",
        targetType: "pod",
        targetId: row.id,
        detail: { fromState: "active", toState: "archived", providerState: "gone", beforeSandbox: true },
      }).catch(() => {});
      result.archived.push(row.id);
      args.log.info(`archived ${row.id} (${row.name})`);
    } catch (e) {
      result.failed.push({ podId: row.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
