/**
 * What a pod cap prices: sandboxes that may still be running at the provider right now.
 * A sleeping pod costs nothing while it sleeps, so it holds no slot — and waking it has
 * to pass the same caps its launch did, or a fleet of stopped pods becomes an unbounded
 * fleet of running ones. Co-located pods run inside another pod's machine and never hold
 * a sandbox of their own, so no cap counts them and no cap refuses them.
 *
 * Both caps live here — the deployment's per-user one and the org policy's — because they
 * share a count, an order, and a shape of sentence, and because launch and wake have to
 * ask them the same question and get the same answer.
 *
 * Atomicity (plan §7.1): preflight counts alone do not serialize unrelated root
 * launches or wakes. The final count/check/reservation runs inside one Postgres
 * transaction holding advisory locks in canonical order (org, then user), with all
 * provider I/O outside. `stopping` holds a slot until a confirmed stop; unknown
 * provider states hold too (fail closed) rather than becoming invisible capacity.
 */
import type pg from "pg";
import { HOST_PROVIDER_NAME } from "../../core/providers/host.js";
import { query, type Queryable } from "../db/index.js";
import { conflict } from "../httperrors.js";
import { parseStoredPolicy, readLayer } from "../settings/merge.js";
import type { PodRow } from "./types.js";

/**
 * Live, booting, or still-stopping at the provider. `stopping` holds its slot until the
 * stop is confirmed: releasing on the DB transition alone would free a slot for a sandbox
 * that may still be running. Every other *known* provider state is asleep, gone, or in
 * between — except `error` with a sandbox id (see quarantine below). Unknown states hold
 * (fail closed) — see HOLDING_POD_SQL.
 */
export const AWAKE_PROVIDER_STATES = [
  "preparing_image",
  "provisioning",
  "starting",
  "started",
  "stopping",
] as const;

/** Known states that never hold a concurrency slot (stopped work, terminal, or brief exits).
 * `error` is listed here as a *known* state, but error rows that still reference a provider
 * sandbox are carved back in by the quarantine clause in HOLDING_POD_SQL: a failed launch
 * may still have live provider resources, and freeing its slot merely because it cannot
 * wake would hide real capacity use. Quarantined rows are counted (see countQuarantined)
 * for operator visibility; the capacity workstream owns their bounded reconciliation and
 * orphan cleanup. Error rows with no sandbox id hold nothing (there is nothing to clean). */
export const NON_HOLDING_PROVIDER_STATES = [
  "stopped",
  "archiving",
  "archived",
  "deleting",
  "error",
  "gone",
] as const;

/** Every provider_state the server writes; anything else is "unknown" and holds. */
const KNOWN_PROVIDER_STATES = [...AWAKE_PROVIDER_STATES, ...NON_HOLDING_PROVIDER_STATES] as const;

/**
 * One SQL spelling of "holds a slot", shared by every cap. Unknown states hold: a future
 * state the server does not recognize must not become invisible capacity. Error rows that
 * still reference a provider sandbox hold as quarantined capacity until confirmed physical
 * stop/cleanup (never silently freed, never killed by the quota path itself).
 */
export const AWAKE_POD_SQL =
  `(provider_state IN (${AWAKE_PROVIDER_STATES.map((state) => `'${state}'`).join(",")})` +
  ` OR (provider_state = 'error' AND provider_sandbox_id IS NOT NULL)` +
  ` OR provider_state NOT IN (${KNOWN_PROVIDER_STATES.map((state) => `'${state}'`).join(",")}))` +
  ` AND provider <> '${HOST_PROVIDER_NAME}'`;

/** Backwards-compatible alias: the holding predicate. */
export const HOLDING_POD_SQL = AWAKE_POD_SQL;

/** How much of each concurrency budget is spent right now. */
export interface AwakePodCounts {
  /** Holding pods across the whole organization — what the org policy cap measures. */
  org: number;
  /** The subset of those owned by one user *in this org* — legacy per-org slice. */
  user: number;
}

/** Quota inputs resolved for one launch/wake decision. */
export interface QuotaCounts {
  /** Holding pods owned by this user across *all* orgs — the deployment cap measures this. */
  globalUser: number;
  /** Holding pods across the pod's organization — the org policy cap measures this. */
  org: number;
}

/** Both counts in one round-trip: the org total and one user's share of it (legacy). */
export async function countAwakePods(orgId: string, userId: string): Promise<AwakePodCounts> {
  const counted = await query<{ org_n: string; user_n: string }>(
    `SELECT count(*) AS org_n, count(*) FILTER (WHERE user_id = $2) AS user_n
       FROM pods WHERE org_id = $1 AND ${AWAKE_POD_SQL}`,
    [orgId, userId],
  );
  const row = counted.rows[0]!;
  return { org: Number(row.org_n), user: Number(row.user_n) };
}

/** Global user budget + org aggregate, in one round-trip. The deployment cap uses globalUser. */
export async function countQuota(
  orgId: string,
  userId: string,
  client: Queryable = { query: (text: string, params?: unknown[]) => query(text, params ?? []) } as Queryable,
): Promise<QuotaCounts> {
  const counted = await client.query(
    `SELECT (SELECT count(*) FROM pods WHERE user_id = $2 AND ${AWAKE_POD_SQL}) AS global_user_n,
            (SELECT count(*) FROM pods WHERE org_id = $1 AND ${AWAKE_POD_SQL}) AS org_n`,
    [orgId, userId],
  );
  const row = counted.rows[0] as { global_user_n: string; org_n: string };
  return { globalUser: Number(row.global_user_n), org: Number(row.org_n) };
}

/**
 * The one rule launch and wake both ask, for a pod that is not holding yet: is there room?
 * The deployment cap (POD_MAX_CONCURRENT_PER_USER) counts the owner's holding pods across
 * all orgs and always applies; an org policy maxConcurrentPods counts the whole org and can
 * therefore only narrow the limit, never raise a user above the deployment cap — so it is
 * asked second. Both sentences say what to do about it: the caps free themselves as soon as
 * any pod reaches a confirmed stop.
 */
export function concurrencyCapRefusal(args: {
  awakeForUser: number;
  awakeForOrg: number;
  perUserCap: number | undefined;
  orgCap: number | undefined;
}): string | null {
  if (args.perUserCap !== undefined && args.awakeForUser >= args.perUserCap) {
    return `this deployment caps concurrent pods per user at ${args.perUserCap}; stop or let another pod sleep first`;
  }
  if (args.orgCap !== undefined && args.awakeForOrg >= args.orgCap) {
    return `org policy caps concurrent pods at ${args.orgCap}; stop or let another pod sleep first`;
  }
  return null;
}

/** The same rule as a refusal: one status code for a cap, wherever the cap was reached. */
export function assertConcurrencyRoom(args: Parameters<typeof concurrencyCapRefusal>[0]): void {
  const refusal = concurrencyCapRefusal(args);
  if (refusal) throw conflict(refusal);
}

/**
 * The org's cap, or undefined when it has none. A cap is a budget, not a security boundary,
 * so an unreadable policy layer leaves pods usable rather than wedging every wake behind a
 * settings hiccup — the deployment cap still applies either way.
 */
export async function orgConcurrencyCap(orgId: string): Promise<number | undefined> {
  return readLayer("org_policy", orgId, orgId)
    .then((layer) => parseStoredPolicy(layer.config ?? {}).policy.maxConcurrentPods)
    .catch(() => undefined);
}

/**
 * Same read inside the caller's quota transaction (plan §7.1 freshness): launch/wake/reuse
 * resolve the org policy *before* the tx for preflight, then re-read here under the
 * advisory locks so a concurrent policy tightening cannot be admitted under. Same
 * budget-not-boundary rule: an unreadable layer inside the tx still means "no org cap".
 */
export async function orgConcurrencyCapTx(
  client: pg.PoolClient | Queryable,
  orgId: string,
): Promise<number | undefined> {
  try {
    const res = await client.query(
      `SELECT config FROM settings WHERE scope_type = 'org_policy' AND scope_id = $1 AND org_id = $1`,
      [orgId],
    );
    const row = (res.rows[0] as { config?: unknown } | undefined);
    if (!row) return undefined;
    return parseStoredPolicy(row.config ?? {}).policy.maxConcurrentPods;
  } catch {
    return undefined;
  }
}

/** Quarantined capacity: error rows that still reference a provider sandbox. */
export interface QuarantineCounts {
  /** Quarantined pods owned by this user across *all* orgs. */
  globalUser: number;
  /** Quarantined pods across the org. */
  org: number;
}

/**
 * Operator visibility for quota-held error rows (plan §7.1 quarantine): how many slots are
 * held by pods in `error` with a sandbox id still attached. The capacity workstream's
 * orphan queue reconciles these; this count keeps them visible instead of leaking silently.
 */
export async function countQuarantined(
  orgId: string,
  userId: string,
  client: Queryable = { query: (text: string, params?: unknown[]) => query(text, params ?? []) } as Queryable,
): Promise<QuarantineCounts> {
  const counted = await client.query(
    `SELECT (SELECT count(*) FROM pods WHERE user_id = $2 AND provider_state = 'error'
              AND provider_sandbox_id IS NOT NULL AND provider <> '${HOST_PROVIDER_NAME}') AS global_user_n,
            (SELECT count(*) FROM pods WHERE org_id = $1 AND provider_state = 'error'
              AND provider_sandbox_id IS NOT NULL AND provider <> '${HOST_PROVIDER_NAME}') AS org_n`,
    [orgId, userId],
  );
  const row = counted.rows[0] as { global_user_n: string; org_n: string };
  return { globalUser: Number(row.global_user_n), org: Number(row.org_n) };
}

// ---------------------------------------------------------------------------
// Atomic reservation (plan §7.1)
// ---------------------------------------------------------------------------

/**
 * Canonical lock order for quota decisions: org advisory lock first, then user advisory
 * lock, then row locks (lineage root, pod). Every launch/wake path takes them in this
 * order so concurrent root/child/wake requests serialize instead of deadlocking.
 * Locks are transaction-scoped (pg_advisory_xact_lock) and release on commit/rollback.
 * Provider I/O stays outside the transaction.
 */
export async function acquireQuotaLocks(
  client: pg.PoolClient | Queryable,
  orgId: string,
  userId: string,
): Promise<void> {
  // Namespace 1 = org quota, 2 = user quota; hashtext gives a stable 32-bit key per id.
  await client.query(`SELECT pg_advisory_xact_lock(1, hashtext($1))`, [`quota-org:${orgId}`]);
  await client.query(`SELECT pg_advisory_xact_lock(2, hashtext($1))`, [`quota-user:${userId}`]);
}

/**
 * Count (inside the caller's transaction, after acquireQuotaLocks) and throw 409 when full.
 * Callers reach here only for a pod that is not holding yet, so the pod is never part of
 * the counts it is measured against. The count is the pod owner's, not the waker's.
 */
export async function assertQuotaRoomTx(
  client: pg.PoolClient | Queryable,
  args: {
    orgId: string;
    userId: string;
    perUserCap: number | undefined;
    orgCap: number | undefined;
  },
): Promise<QuotaCounts> {
  const counts = await countQuota(args.orgId, args.userId, client);
  assertConcurrencyRoom({
    awakeForUser: counts.globalUser,
    awakeForOrg: counts.org,
    perUserCap: args.perUserCap,
    orgCap: args.orgCap,
  });
  return counts;
}

/**
 * The caps on the wake path (preflight only — not atomic). Callers that need the race-proof
 * guarantee must use assertQuotaRoomTx inside the same transaction that claims the
 * wake (see lifecycle ensureProviderPodStartedWithResult). Kept because gateway probes and
 * error messages need a cheap non-transactional check; the transactional check is final.
 */
export async function assertRoomToWake(
  pod: Pick<PodRow, "org_id" | "user_id" | "provider">,
  perUserCap: number | undefined,
): Promise<void> {
  if (pod.provider === HOST_PROVIDER_NAME) return;
  const [orgCap, counts] = await Promise.all([
    orgConcurrencyCap(pod.org_id),
    countQuota(pod.org_id, pod.user_id),
  ]);
  assertConcurrencyRoom({
    awakeForUser: counts.globalUser,
    awakeForOrg: counts.org,
    perUserCap,
    orgCap,
  });
}
