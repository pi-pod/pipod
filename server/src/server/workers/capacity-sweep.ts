/**
 * Capacity-wait reaper + grant-ledger hygiene (§§6.6, 7.3).
 *
 * Runs every 15s from the worker loop (cheap no-op without wait rows):
 *
 * - expire waits past their deadline → fail their pods with a typed capacity
 *   result (final-deadline failure, distinct from waiting); wait expiry never
 *   sends a provider cancellation or otherwise mutates an ambiguous host attempt;
 * - orphan waits (heartbeat dead, deadline still future — owner died via
 *   restart/crash) → fail closed the same way. The owner heartbeats every
 *   10s; the grace below is 3x that, so a live owner is never reaped;
 * - prune terminal rows older than an hour (operator visibility window);
 * - expire stale grant-ledger rows (allocator re-issues while enabled).
 *
 * Metering never blocks product paths: every per-row failure is caught and
 * logged, never thrown.
 */
import { query } from "../db/index.js";
import { sanitizeFailureMessage } from "../safe-errors.js";
import { observeCapacityWait } from "../metrics.js";
import { capacityWaitDisplay, claimOrphanedWait, getCapacityWait } from "../pods/capacity-wait.js";
import {
  CAPACITY_WAIT_EXPIRED_CODE,
  CAPACITY_WAIT_ORPHANED_CODE,
  recordProvisioningFailure,
  renderCapacityWaitTerminal,
} from "../pods/provision-failure.js";
import type { KekProvider } from "../secrets/crypto.js";
import {
  expireDueWaits,
  findOrphanedWaits,
  pruneFinishedWaits,
  type CapacityWaitRow,
  type WaitStore,
} from "../pods/capacity-wait.js";
import { markGrantsExpired } from "../pods/cpu-fairness.js";
import { renderAdmissionMessage } from "../safe-errors.js";

/** Heartbeat grace before a waiting pod is declared orphaned (3x the 10s beat). */
export const WAIT_ORPHAN_GRACE_MS = 30_000;

const store: WaitStore = {
  query: (text: string, params?: unknown[]) => query(text, params ?? []),
};

/** Pre-wake states a stuck wake claim may return to (allowlist; anything else is left alone). */
const WAKE_ROLLBACK_STATES = new Set(["stopped", "archived"]);

/**
 * End a wake wait WITHOUT touching the host: wake cancellation ends the
 * WAITING only. The workspace (and any active job on it) is never stopped,
 * deleted, or force-archived by this path, and no host operation is ever
 * cancelled for a wake row — `operation_key` is a waiter-identity marker
 * (`wake:<podId>`), and native DELETE-by-key on the original create op
 * would DELETE the entire existing workspace including its archive.
 * A claim stuck at 'starting' (waiter died between claim and rollback)
 * returns to the recorded pre-wake state; anything else is already where
 * the attempt-failure rollback left it (stopped/archived + state_reason).
 */
/**
 * Exported for Postgres coverage of the orphan-race guards (a stale row
 * object passed after a concurrent waiter already decided the outcome must
 * change nothing and count nothing).
 */
export async function failWakeWaitPod(
  row: CapacityWaitRow,
  outcome: "expired" | "orphaned",
  log: { warn: (m: string) => void },
): Promise<void> {
  // Orphan rows arrive as a stale SELECT: claim the transition first. A
  // null claim means a concurrent waiter (or a prior tick) already decided
  // the outcome — it was already counted there, so do nothing further.
  // Expired rows arrive already transitioned by this tick's expireDueWaits.
  if (outcome === "orphaned") {
    const owned = await claimOrphanedWait(store, row.pod_id).catch(() => null);
    if (!owned) {
      log.warn(
        `pod ${row.pod_id} wake wait left 'waiting' before orphan handling; outcome already decided elsewhere`,
      );
      return;
    }
  }
  const intent = row.intent as { fromState?: unknown } | null;
  const fromState = typeof intent?.fromState === "string" ? intent.fromState : null;
  // Validated display only (§6.3): an unrecognized row reason falls back to
  // the fleet_capacity slug — raw row text never enters state_reason.
  const reasonText = capacityWaitDisplay(row).reason ?? "fleet_capacity";
  const message =
    `${outcome === "orphaned" ? "wake wait orphaned by a server restart" : "wake wait expired"}: ` +
    `${reasonText} — workspace untouched, retry the wake`;
  if (fromState !== null && WAKE_ROLLBACK_STATES.has(fromState)) {
    await query(
      `UPDATE pods SET provider_state = $2, provider_state_changed_at = now(),
         state_reason = $3, updated_at = now()
       WHERE id = $1 AND provider_state = 'starting'`,
      [row.pod_id, fromState, message.slice(0, 500)],
    ).catch(() => null);
  } else {
    warnUnusableWakeIntent(log, row, outcome, fromState);
  }
  log.warn(`pod ${row.pod_id} wake wait ${outcome} (reason ${reasonText}); workspace preserved`);
  // Exactly-once: the orphan claim above already counted `orphaned`; only
  // the expired path (transitioned by this tick's expireDueWaits, which
  // counts nothing itself) is counted here.
  if (outcome === "expired") observeCapacityWait(outcome);
}

function warnUnusableWakeIntent(
  log: { warn: (m: string) => void },
  row: CapacityWaitRow,
  outcome: "expired" | "orphaned",
  fromState: string | null,
): void {
  log.warn(
    `pod ${row.pod_id} wake wait ${outcome} with unusable rollback intent ` +
      `(fromState ${JSON.stringify(fromState)}); claim left for the reconciler, workspace untouched`,
  );
}

/**
 * Exported for Postgres coverage of the orphan-race guards (see
 * {@link failWakeWaitPod}).
 */
export async function failWaitPod(
  row: CapacityWaitRow,
  outcome: "expired" | "orphaned",
  log: { warn: (m: string) => void },
  /** Retained for call-site compatibility; expiration is deliberately provider-read-only. */
  _bootToken: string | null,
  _kek?: KekProvider,
): Promise<void> {
  // Wake waits and create waits both terminate locally; no provider operation is cancelled.
  if ((row.kind ?? "create") === "wake") {
    await failWakeWaitPod(row, outcome, log);
    return;
  }
  // Claim first and use the returned attempt tuple, never a stale sweep snapshot.
  // A new heartbeat prevents orphan cancellation; an A→B retry cleans up B only.
  if (outcome === "orphaned") {
    const owned = await claimOrphanedWait(store,row.pod_id,WAIT_ORPHAN_GRACE_MS).catch(() => null);
    if (!owned) return;
    row = owned;
  } else {
    const current = await getCapacityWait(store,row.pod_id).catch(() => null);
    if (!current || current.status !== "expired") return;
    row = current;
  }
  const pod = await query(
    `SELECT id, org_id, user_id, state, provider_state, provider_sandbox_id, resolved_config
       FROM pods WHERE id = $1`,
    [row.pod_id],
  ).catch(() => null);
  const podRow = pod?.rows[0] as
    | {
        id: string;
        org_id: string;
        user_id: string;
        state: string;
        provider_state: string;
        provider_sandbox_id: string | null;
        resolved_config: unknown;
      }
    | undefined;
  if (
    podRow &&
    podRow.state === "active" &&
    podRow.provider_sandbox_id === null &&
    (podRow.provider_state === "preparing_image" || podRow.provider_state === "provisioning")
  ) {
    // Typed terminal (never host prose): the display projection carries only
    // validated enums/numbers, and the failure recorder keeps the code while
    // the row converges to archived (never-started launches must not linger
    // as active). Client-visible copy renders from the reason enum, never
    // from the wait row's free-form fields.
    const display = capacityWaitDisplay(row);
    const waitedSeconds = Math.max(
      0,
      Math.round((Date.parse(row.deadline_at) - Date.parse(row.created_at)) / 1000),
    );
    const code = outcome === "orphaned" ? CAPACITY_WAIT_ORPHANED_CODE : CAPACITY_WAIT_EXPIRED_CODE;
    const message = renderCapacityWaitTerminal({
      reason: display.reason ?? "fleet_capacity",
      waitedSeconds,
      outcome,
    });
    await recordProvisioningFailure({
      podId: podRow.id,
      orgId: podRow.org_id,
      userId: podRow.user_id,
      report: podRow.resolved_config as never,
      message,
      code,
    }).catch(() => null);
    log.warn(`pod ${row.pod_id} capacity wait ${outcome} (reason ${display.reason ?? "fleet_capacity"})`);
  }
  // Exactly-once: see failWakeWaitPod — the orphan claim counts `orphaned`.
  if (outcome === "expired") observeCapacityWait(outcome);
}

export async function runCapacityWaitSweep(deps: {
  kek?: KekProvider;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /**
   * Boot-parsed env (ServerEnv). REQUIRED: host cleanup authenticates from
   * this snapshot only — never ambient process.env, which may transiently
   * hold a BYO org key during a provider overlay. Absent/empty token reads
   * as null (skip host cleanup), never as another org's ambient key.
   */
  env: { PI_POD_SANDBOX_TOKEN?: unknown };
}): Promise<void> {
  try {
    const expired = await expireDueWaits(store);
    for (const row of expired) {
      await failWaitPod(row, "expired", deps.log, null, deps.kek).catch((e) =>
        deps.log.error(
          sanitizeFailureMessage(e, { prefix: `capacity sweep failed pod ${row.pod_id}` }),
        ),
      );
    }
    const orphaned = await findOrphanedWaits(store, WAIT_ORPHAN_GRACE_MS);
    for (const row of orphaned) {
      await failWaitPod(row, "orphaned", deps.log, null, deps.kek).catch((e) =>
        deps.log.error(
          sanitizeFailureMessage(e, { prefix: `capacity sweep failed pod ${row.pod_id}` }),
        ),
      );
    }
    await pruneFinishedWaits(store).catch(() => 0);
    await markGrantsExpired(store).catch(() => 0);
  } catch (e) {
    deps.log.error(sanitizeFailureMessage(e, { prefix: "capacity wait sweep failed" }));
  }
}
