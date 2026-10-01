/**
 * Fleet-wide CPU fairness allocator (§7.3).
 *
 * Host-local equal parent weights alone are insufficient: a user present on
 * several workers collects several shares. This control-plane allocator:
 *
 * 1. computes equal-entitlement, demand-capped user shares across the
 *    available worker CPU budgets, respecting each user's existing host
 *    placement (documented constraint: no live migration is implied);
 * 2. splits each user's allocation among its host-local parent groups and
 *    applies versioned, short-lived CPU budget grants (revisions reject stale
 *    updates; expiry uses host-local monotonic time, never wall clocks);
 * 3. keeps a central ledger (`cpu_grant_ledger`, migration 053) so async
 *    changes cannot spend the same fleet capacity twice;
 * 4. under allocator/network failure keeps existing sandboxes running with the
 *    conservative local sharing fallback (equal weights, no cap), pauses new
 *    grant-requiring admissions (typed `fairness_degraded`, retryable), and
 *    exposes the degradation explicitly — never kills/frees work, never grants
 *    unlimited CPU.
 *
 * Rollout: observation mode → host-local parents → fleet grants after solver
 * and fault behavior pass tests. Gated by `CPU_FAIRNESS_ENABLED` (default
 * OFF until qualification); when off, nothing here issues grants or gates
 * admissions and every host stays on local weights.
 */
/**
 * Minimal query surface both the shared pool facade and a pg transaction
 * client satisfy — avoids overload-assignability friction with PoolClient.
 */
export interface WaitStore {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface FairnessUserDemand {
  userKey: string;
  /** Cores of runnable demand (measured, or live-sandbox proxy before usage feed). */
  demandCores: number;
  /** Hosts where the user currently has live sandboxes (placement constraint). */
  hostIds: readonly string[];
  /** Live sandbox count per host (fallback split weight when demand is host-blind). */
  sandboxesPerHost: Readonly<Record<string, number>>;
}

export interface FairnessHostBudget {
  hostId: string;
  /** Sharable CPU budget in cores (host budget after reserve). */
  budgetCores: number;
  reachable: boolean;
}

export interface FairnessShare {
  userKey: string;
  hostId: string;
  /** Cores granted on this host's tenant parent; null = weights only (no cap). */
  cpuCores: number | null;
}

/**
 * Topology-constrained max-min fair shares, capped by demand (pure).
 *
 * Guarantees (proven by construction, pinned by tests):
 * - every host's granted sum is <= its budget (no over-admit, ever);
 * - every user's granted total is <= its demand (idle borrowers leave
 *   their share; unused demand is redistributed by re-solving);
 * - users with no reachable host get nothing and consume no budget;
 * - max-min fairness subject to placement: no user's total can be raised
 *   without lowering an equal-or-smaller total (bottleneck users freeze
 *   together at the binding constraint; unconstrained users share the rest).
 *
 * Method: progressive filling with bipartite max-flow feasibility (Dinic).
 * All unsaturated users rise together by the largest jointly-placeable
 * increment; users that cannot gain even alone (all their hosts saturated)
 * freeze at the bottleneck. No live migration is implied: a user is only
 * ever granted on hosts it already occupies.
 *
 * Determinism: fixed input order drives fixed graph order, so the same
 * inputs always produce the same splits. Callers canonicalize (sort) inputs
 * for cross-tick stability; only per-user TOTALS carry the fairness promise
 * (split placement among symmetric hosts may follow input order).
 */
export function solveCpuShares(args: {
  users: readonly FairnessUserDemand[];
  hosts: readonly FairnessHostBudget[];
}): FairnessShare[] {
  const reachable = args.hosts.filter((host) => host.reachable && host.budgetCores > 0);
  if (reachable.length === 0) return [];
  const budgets = new Map<string, number>(reachable.map((host) => [host.hostId, host.budgetCores]));
  const candidates = args.users
    .map((user) => ({
      user,
      demand: Math.max(0, user.demandCores),
      edges: user.hostIds.filter((hostId) => budgets.has(hostId)),
    }))
    .filter((entry) => entry.demand > EPS && entry.edges.length > 0);
  if (candidates.length === 0) return [];

  const residual = new Map<string, number>(budgets);
  const remaining = new Map<string, number>(candidates.map((entry) => [entry.user.userKey, entry.demand]));
  const perEdge = new Map<string, Map<string, number>>();
  const edgeFlow = (userKey: string, hostId: string): number => perEdge.get(userKey)?.get(hostId) ?? 0;
  const addEdgeFlow = (userKey: string, hostId: string, cores: number): void => {
    let edges = perEdge.get(userKey);
    if (!edges) {
      edges = new Map();
      perEdge.set(userKey, edges);
    }
    edges.set(hostId, (edges.get(hostId) ?? 0) + cores);
  };
  const active = new Set<string>(candidates.map((entry) => entry.user.userKey));
  const byKey = new Map<string, (typeof candidates)[number]>(
    candidates.map((entry) => [entry.user.userKey, entry]),
  );

  // Max flow placeable for exactly the users in `subset` with per-user supply
  // caps, against current residuals. Returns the value and the per-edge flows.
  const flowFor = (
    subset: readonly string[],
    supplyCap: (userKey: string) => number,
  ): { value: number; edges: Array<{ userKey: string; hostId: string; cores: number }> } => {
    const users = subset.map((key) => byKey.get(key)!).filter(Boolean);
    const hostIndex = new Map<string, number>();
    for (const entry of users) for (const hostId of entry.edges) {
      if (!hostIndex.has(hostId)) hostIndex.set(hostId, hostIndex.size);
    }
    const H = hostIndex.size;
    const U = users.length;
    const source = 0;
    const sink = 1 + U + H;
    const dinic = new Dinic(sink + 1);
    const supplies = new Map<string, number>(users.map((entry) => [entry.user.userKey, Math.max(0, supplyCap(entry.user.userKey))]));
    const edgeRef: Array<{ userKey: string; hostId: string; init: number; forward: { to: number; rev: number; cap: number } }> = [];
    users.forEach((entry, i) => {
      dinic.addEdge(source, 1 + i, supplies.get(entry.user.userKey) ?? 0);
      for (const hostId of entry.edges) {
        // Tight edge cap: no feasible flow ever exceeds min(supply, residual),
        // so this never binds tighter than the true constraints — and keeps
        // magnitudes at problem scale, where float readback stays exact
        // (a huge INF constant would quantize flows to its ulp and over-admit).
        const init = Math.min(supplies.get(entry.user.userKey) ?? 0, Math.max(0, residual.get(hostId) ?? 0));
        const forward = dinic.addEdge(1 + i, 1 + U + hostIndex.get(hostId)!, init);
        edgeRef.push({ userKey: entry.user.userKey, hostId, init, forward });
      }
    });
    for (const [hostId, index] of hostIndex) {
      dinic.addEdge(1 + U + index, sink, Math.max(0, residual.get(hostId) ?? 0));
    }
    const value = dinic.maxFlow(source, sink);
    // Read back per-edge flows from consumed capacity (exact at this scale).
    const edges = edgeRef.map((ref) => ({
      userKey: ref.userKey,
      hostId: ref.hostId,
      cores: ref.init - ref.forward.cap,
    }));
    return { value, edges };
  };

  let rounds = 0;
  let idleRounds = 0;
  const maxRounds = 4 * candidates.length + 10;
  while (active.size > 0 && rounds < maxRounds) {
    rounds += 1;
    let progressed = false;
    // 1. Freeze demand-met users.
    for (const key of [...active]) {
      if ((remaining.get(key) ?? 0) <= EPS) {
        active.delete(key);
        progressed = true;
      }
    }
    if (active.size === 0) break;
    // 2. Freeze users bottlenecked on saturated hosts (cannot gain even alone).
    const soloGains = new Map<string, number>();
    for (const key of [...active]) {
      const alone = flowFor([key], () => remaining.get(key) ?? 0);
      soloGains.set(key, alone.value);
      if (alone.value <= EPS) {
        active.delete(key);
        progressed = true;
      }
    }
    if (active.size === 0) break;
    // 3. Largest jointly-placeable uniform increment (binary search; the
    //    averaging argument guarantees strictly positive progress while any
    //    active user can gain alone, so this always advances or step 2
    //    freezes someone next round).
    const keys = [...active];
    const ceil = Math.max(...keys.map((key) => remaining.get(key) ?? 0));
    let lo = 0;
    let hi = ceil;
    let best: { value: number; edges: Array<{ userKey: string; hostId: string; cores: number }> } | null = null;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      const attempt = flowFor(keys, (key) => Math.min(mid, remaining.get(key) ?? 0));
      const target = keys.reduce((sum, key) => sum + Math.min(mid, remaining.get(key) ?? 0), 0);
      if (attempt.value >= target - EPS) {
        lo = mid;
        best = attempt;
      } else {
        hi = mid;
      }
    }
    // Progress bound from the averaging argument: uniform g_min/|S| is always
    // feasible, so committing above EPS/|S| can never stall while gains exist.
    if (best && lo > EPS / Math.max(1, keys.length)) {
      progressed = true;
      for (const edge of best.edges) {
        if (edge.cores <= 0) continue;
        addEdgeFlow(edge.userKey, edge.hostId, edge.cores);
        residual.set(edge.hostId, (residual.get(edge.hostId) ?? 0) - edge.cores);
        remaining.set(edge.userKey, (remaining.get(edge.userKey) ?? 0) - edge.cores);
      }
    }
    // Next round's steps 1–2 freeze whoever this increment blocked or filled.
    // Float-dust backstop (practically unreachable): two idle rounds freeze
    // the least-placeable user so the loop always terminates with a feasible
    // (never over-budget) allocation.
    idleRounds = progressed ? 0 : idleRounds + 1;
    if (idleRounds >= 2 && active.size > 0) {
      let victim: string | null = null;
      for (const key of active) {
        if (victim === null || (soloGains.get(key) ?? 0) < (soloGains.get(victim) ?? 0)) victim = key;
      }
      if (victim !== null) active.delete(victim);
      idleRounds = 0;
    }
  }

  const out: FairnessShare[] = [];
  for (const entry of candidates) {
    const edges = perEdge.get(entry.user.userKey);
    if (!edges) continue;
    for (const [hostId, cores] of edges) {
      if (cores > EPS) out.push({ userKey: entry.user.userKey, hostId, cpuCores: cores });
    }
  }
  return out;
}

/** Numerical zero for core accounting (budgets/demands are whole or 2-decimal). */
const EPS = 1e-9;

/** Deterministic Dinic max flow (adjacency in insertion order; no randomness). */
class Dinic {
  private readonly graph: Array<Array<{ to: number; rev: number; cap: number }>>;

  constructor(nodeCount: number) {
    this.graph = Array.from({ length: nodeCount }, () => []);
  }

  addEdge(from: number, to: number, cap: number): { to: number; rev: number; cap: number } {
    const forward = { to, rev: this.graph[to]!.length, cap };
    const backward = { to: from, rev: this.graph[from]!.length, cap: 0 };
    this.graph[from]!.push(forward);
    this.graph[to]!.push(backward);
    return forward;
  }

  maxFlow(source: number, sink: number): number {
    let value = 0;
    const level = new Array<number>(this.graph.length);
    for (;;) {
      level.fill(-1);
      level[source] = 0;
      const queue = [source];
      for (let head = 0; head < queue.length; head++) {
        const node = queue[head]!;
        for (const edge of this.graph[node]!) {
          if (edge.cap > 0 && level[edge.to] === -1) {
            level[edge.to] = level[node]! + 1;
            queue.push(edge.to);
          }
        }
      }
      if (level[sink] === -1) break;
      const next = new Array<number>(this.graph.length).fill(0);
      for (;;) {
        const pushed = this.drain(source, sink, Number.POSITIVE_INFINITY, level, next);
        if (pushed <= 0) break;
        value += pushed;
      }
    }
    return value;
  }

  private drain(source: number, sink: number, flow: number, level: number[], next: number[]): number {
    if (source === sink) return flow;
    const edges = this.graph[source]!;
    for (let i = next[source]!; i < edges.length; i++) {
      next[source] = i;
      const edge = edges[i]!;
      if (edge.cap > 0 && level[edge.to] === level[source]! + 1) {
        const pushed = this.drain(edge.to, sink, Math.min(flow, edge.cap), level, next);
        if (pushed > 0) {
          edge.cap -= pushed;
          this.graph[edge.to]![edge.rev]!.cap += pushed;
          return pushed;
        }
      }
    }
    next[source] = edges.length;
    return 0;
  }
}

export interface CpuFairnessEnv {
  CPU_FAIRNESS_ENABLED?: unknown;
  CPU_GRANT_TTL_MS?: unknown;
  CPU_ALLOCATOR_INTERVAL_MS?: unknown;
}

export interface CpuFairnessConfig {
  enabled: boolean;
  /** Host-local grant validity per issue (1s … 1h per native contract). */
  grantTtlMs: number;
  /** How often the allocator re-solves and re-issues. */
  intervalMs: number;
}

export function cpuFairnessConfig(env: CpuFairnessEnv): CpuFairnessConfig {
  const enabled =
    env.CPU_FAIRNESS_ENABLED === true || env.CPU_FAIRNESS_ENABLED === "true" || env.CPU_FAIRNESS_ENABLED === 1;
  const grantTtlMs =
    typeof env.CPU_GRANT_TTL_MS === "number" && Number.isFinite(env.CPU_GRANT_TTL_MS)
      ? Math.min(3_600_000, Math.max(1_000, Math.floor(env.CPU_GRANT_TTL_MS)))
      : 60_000;
  const intervalMs =
    typeof env.CPU_ALLOCATOR_INTERVAL_MS === "number" && Number.isFinite(env.CPU_ALLOCATOR_INTERVAL_MS)
      ? Math.min(300_000, Math.max(5_000, Math.floor(env.CPU_ALLOCATOR_INTERVAL_MS)))
      : 15_000;
  return { enabled, grantTtlMs, intervalMs };
}

/**
 * Atomically allocate the next grant revision for (host, user) AND record
 * the solved intent, in ONE statement (migration 055).
 *
 * The old SELECT-then-UPSERT was not an atomic CAS: concurrent controllers
 * could read the same high-water mark and reuse (or lower) a revision. Here
 * Postgres serializes on the row lock and computes
 * `GREATEST(revision + 1, nowMs)` inside the write, so every allocator —
 * leader or split-brain zombie — gets a distinct strictly-increasing
 * revision back via RETURNING. The host still rejects stale revisions (409)
 * as the second guard: an ex-leader's delayed PUT can never lower state.
 */
export async function allocateGrantRevision(
  client: WaitStore,
  args: { hostId: string; userKey: string; nowMs: number; cpuCores: number | null; ttlMs: number },
): Promise<number> {
  const result = await client.query(
    `INSERT INTO cpu_grant_ledger
       (host_id, user_key, revision, cpu_cores, desired_cpu_cores, expires_at, state, updated_at)
     VALUES ($1, $2, GREATEST($3::bigint, 1), $4, $4, now() + make_interval(secs => $5), 'active', now())
     ON CONFLICT (host_id, user_key) DO UPDATE SET
       revision = GREATEST(cpu_grant_ledger.revision + 1, EXCLUDED.revision),
       cpu_cores = EXCLUDED.cpu_cores,
       desired_cpu_cores = EXCLUDED.desired_cpu_cores,
       issued_at = now(),
       expires_at = EXCLUDED.expires_at,
       state = 'active',
       updated_at = now()
     RETURNING revision`,
    [args.hostId, args.userKey, Math.floor(args.nowMs), args.cpuCores, args.ttlMs / 1000],
  );
  const revision = Number(result.rows[0]?.revision);
  if (!Number.isFinite(revision)) throw new Error("grant revision allocation returned no revision");
  return revision;
}

export interface ConfirmedGrant {
  hostId: string;
  userKey: string;
  revision: number;
  desiredCpuCores: number | null;
  confirmedCpuCores: number | null;
  confirmedRevision: number | null;
  confirmedAt: string | null;
  /** 'stale' ⟹ last push failed or refresh overdue: host on bounded fallback. */
  freshness: "fresh" | "stale";
}

/** Last host-confirmed state per grant (what is actually applied out there). */
export async function readConfirmedGrants(client: WaitStore): Promise<ConfirmedGrant[]> {
  const result = await client.query(
    `SELECT host_id, user_key, revision, desired_cpu_cores,
            confirmed_cpu_cores, confirmed_revision, confirmed_at, freshness
       FROM cpu_grant_ledger`,
  );
  return result.rows.map((row) => ({
    hostId: String(row.host_id),
    userKey: String(row.user_key),
    revision: Number(row.revision),
    desiredCpuCores: row.desired_cpu_cores === null ? null : Number(row.desired_cpu_cores),
    confirmedCpuCores: row.confirmed_cpu_cores === null ? null : Number(row.confirmed_cpu_cores),
    confirmedRevision: row.confirmed_revision === null ? null : Number(row.confirmed_revision),
    confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
    freshness: row.freshness === "stale" ? "stale" : "fresh",
  }));
}

/**
 * Confirm a pushed grant: only the exact allocated revision may confirm, so a
 * newer allocation (another leader won the race) is never overwritten by a
 * stale confirmation. On timeout/crash this row is simply never written and
 * the previous confirmed (higher, on decreases) values stay charged.
 * Confirmation also clears staleness: the host just ACKed this exact state.
 */
export async function confirmGrant(
  client: WaitStore,
  args: { hostId: string; userKey: string; revision: number; cpuCores: number | null },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE cpu_grant_ledger
        SET confirmed_cpu_cores = $4, confirmed_revision = $3, confirmed_at = now(),
            freshness = 'fresh', state = 'active', updated_at = now()
      WHERE host_id = $1 AND user_key = $2 AND revision = $3`,
    [args.hostId, args.userKey, args.revision, args.cpuCores],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Mark a pair stale after a failed push: the host is on its bounded local
 * fallback (or unreachable), NOT on our confirmed values. Confirmed stays
 * charged (safe direction) but phase-2 defers new spending on that host
 * until a push confirms again. Never clears confirmed state.
 */
export async function markGrantStale(
  client: WaitStore,
  args: { hostId: string; userKey: string },
): Promise<void> {
  await client.query(
    `UPDATE cpu_grant_ledger SET freshness = 'stale', updated_at = now()
      WHERE host_id = $1 AND user_key = $2`,
    [args.hostId, args.userKey],
  );
}

/**
 * A confirmed grant needs a TTL refresh push when its host-side validity is
 * more than half spent. Without refreshes, holds (no RPC on unchanged
 * values) would let TTLs lapse while the ledger still claimed the old cap.
 * Pairs never confirmed have nothing to refresh (their first push is an
 * increase, handled by the phase planner).
 */
export function grantRefreshDue(
  grant: Pick<ConfirmedGrant, "confirmedCpuCores" | "confirmedAt">,
  ttlMs: number,
  nowMs: number,
): boolean {
  if (grant.confirmedCpuCores === null && grant.confirmedAt === null) return false;
  if (grant.confirmedAt === null) return true;
  return nowMs - Date.parse(grant.confirmedAt) > ttlMs / 2;
}

/**
 * Adopt a host-observed revision floor after a 409 stale_revision: the host
 * has seen a newer grant than this ledger (another controller, or a grant
 * issued before a ledger loss). Raises the high-water mark without touching
 * confirmed state — the next allocate() then necessarily exceeds it.
 */
export async function adoptHostRevision(
  client: WaitStore,
  args: { hostId: string; userKey: string; hostRevision: number },
): Promise<void> {
  await client.query(
    `INSERT INTO cpu_grant_ledger (host_id, user_key, revision, expires_at, state)
     VALUES ($1, $2, GREATEST($3::bigint, 1), now() + make_interval(secs => 60), 'active')
     ON CONFLICT (host_id, user_key) DO UPDATE SET
       revision = GREATEST(cpu_grant_ledger.revision, EXCLUDED.revision),
       updated_at = now()`,
    [args.hostId, args.userKey, Math.floor(args.hostRevision)],
  );
}

/**
 * Durable leader lease: at most one allocator issues grants at a time.
 * Acquire is one atomic statement — INSERT, or take over an expired lease.
 * A crashed holder's lease lapses and the next tick takes over; the host's
 * stale-revision guard remains the backstop against a zombied ex-leader.
 * Returns true only when this holder now owns the lease.
 */
export async function acquireAllocatorLease(
  client: WaitStore,
  args: { holder: string; ttlMs: number },
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO grant_allocator_lease (id, holder, expires_at, updated_at)
     VALUES (1, $1, now() + make_interval(secs => $2), now())
     ON CONFLICT (id) DO UPDATE SET
       holder = EXCLUDED.holder,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()
     WHERE grant_allocator_lease.expires_at <= now()
        OR grant_allocator_lease.holder = EXCLUDED.holder
     RETURNING holder`,
    [args.holder, args.ttlMs / 1000],
  );
  return (result.rowCount ?? 0) > 0 && result.rows[0]?.holder === args.holder;
}

export async function markGrantsExpired(client: WaitStore): Promise<number> {
  // GC only aspirations that never landed: confirmed rows stay charged even
  // past ledger TTL (the host may still enforce them; freshness carries the
  // caution, and revocation clears them once the host ACKs it).
  const result = await client.query(
    `UPDATE cpu_grant_ledger SET state = 'expired', updated_at = now()
      WHERE state = 'active' AND confirmed_cpu_cores IS NULL AND expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}

/**
 * Split one tick's solved grants into phases (pure).
 *
 * Decreases (desired < confirmed) go first: freeing CPU before spending it
 * keeps every host sum within budget at every step. New grants (never
 * confirmed) count as increases against the post-decrease residual.
 */
export interface GrantPhaseItem {
  hostId: string;
  userKey: string;
  /** Solved total; null revokes to weights-only (no cap). */
  desired: number | null;
  confirmed: number | null;
}

export function planGrantPhases(args: {
  desired: readonly FairnessShare[];
  confirmed: readonly ConfirmedGrant[];
}): { decreases: GrantPhaseItem[]; increases: GrantPhaseItem[] } {
  const confirmedByPair = new Map<string, number>();
  for (const grant of args.confirmed) {
    if (grant.confirmedCpuCores !== null) {
      confirmedByPair.set(`${grant.hostId}|${grant.userKey}`, grant.confirmedCpuCores);
    }
  }
  const decreases: GrantPhaseItem[] = [];
  const increases: GrantPhaseItem[] = [];
  for (const share of args.desired) {
    const confirmed = confirmedByPair.get(`${share.hostId}|${share.userKey}`) ?? null;
    const item: GrantPhaseItem = { hostId: share.hostId, userKey: share.userKey, desired: share.cpuCores, confirmed };
    if (share.cpuCores === null) {
      // Revocation to weights-only: a decrease whenever a cap is confirmed.
      if (confirmed !== null) decreases.push(item);
      continue;
    }
    if (confirmed !== null && share.cpuCores < confirmed - EPS) decreases.push(item);
    else if (confirmed === null || share.cpuCores > confirmed + EPS) increases.push(item);
    // Within EPS of confirmed: hold (no RPC; the host already applies it).
  }
  return { decreases, increases };
}

/**
 * Clamp increases to post-decrease confirmed residuals (pure).
 *
 * `confirmedTotals` maps each host to its confirmed sum AFTER phase-1
 * decreases landed. Increases are granted in canonical userKey order, each
 * capped at the remaining residual; the rest is deferred (stays desired but
 * unconfirmed) rather than over-spending the budget. Deferred grants are
 * retried next tick after the next solve.
 */
export function fitIncreasesToConfirmed(args: {
  increases: readonly GrantPhaseItem[];
  confirmedTotals: ReadonlyMap<string, number>;
  budgets: ReadonlyMap<string, number>;
  /**
   * Hosts with stale pairs (push failed or refresh overdue: host on bounded
   * fallback, not on our confirmed values). Increases there are deferred —
   * spending against unconfirmed state could over-admit a host whose real
   * usage already exceeds what we charge. Decreases are unaffected.
   */
  staleHosts?: ReadonlySet<string>;
}): GrantPhaseItem[] {
  const residual = new Map<string, number>();
  for (const [hostId, budget] of args.budgets) {
    residual.set(hostId, Math.max(0, budget - (args.confirmedTotals.get(hostId) ?? 0)));
  }
  const granted: GrantPhaseItem[] = [];
  const ordered = [...args.increases].sort(
    (a, b) => a.hostId.localeCompare(b.hostId) || a.userKey.localeCompare(b.userKey),
  );
  for (const item of ordered) {
    if (args.staleHosts?.has(item.hostId)) continue;
    const room = residual.get(item.hostId) ?? 0;
    // `desired` is the solved TOTAL; only the delta above confirmed spends
    // residual. A delta that does not fit is deferred, never part-granted
    // below its confirmed floor (that would be an unplanned decrease).
    // Revocations (desired null) never flow through increases.
    if (item.desired === null) continue;
    const delta = item.desired - (item.confirmed ?? 0);
    if (delta <= EPS) continue;
    if (room <= EPS) continue;
    const funded = Math.min(delta, room);
    residual.set(item.hostId, room - funded);
    granted.push({ ...item, desired: (item.confirmed ?? 0) + funded });
  }
  return granted;
}

/**
 * Conservative admission gate for partitions (§7.3.4): while the fleet is
 * grant-managed, a host reporting `degraded` (some tenant on the bounded local
 * fallback) refuses NEW grant-requiring admissions with retryable
 * `fairness_degraded` until the allocator recovers. Existing sandboxes keep
 * running; nothing is killed or frozen. Hosts on `local-weights` (never
 * managed) are unaffected — there is nothing to degrade from.
 */
export function shouldGateForDegradedFairness(fairness: {
  mode: "local-weights" | "grants" | "degraded";
  managed: boolean;
}): boolean {
  return fairness.managed && fairness.mode === "degraded";
}

/**
 * Whether placement must resolve the per-tenant grant before admitting
 * anyone there (W12, §7.3).
 *
 * ANY managed host — `grants` as well as `degraded` — refuses grantless
 * tenants at create time while its admission gate is on (native
 * `assertFairnessAvailable` does not consult the degraded count), so
 * placing a grantless tenant there unchecked just burns a create and
 * spins the outer wait loop behind a freshly reset deadline. The tenant
 * escape hatch is the same as the degraded gate: an owner WITH an active
 * grant is still admitted.
 *
 * Hosts reporting the gate OFF (`PI_POD_SANDBOX_GRANT_GATE_ADMISSION=0`,
 * the documented rollback) skip the check: the host admits everyone onto
 * the bounded fallback, and excluding them here would wedge the very
 * launches the rollback is restoring. Unknown gate (hosts predating the
 * report) is gate-ON conservative: with a healthy allocator the
 * resulting wait converges on the bootstrap grant.
 */
export function shouldCheckTenantGrant(fairness: {
  mode: "local-weights" | "grants" | "degraded";
  managed: boolean;
  gateAdmissions?: boolean;
}): boolean {
  if (!fairness.managed || fairness.mode === "local-weights") return false;
  return fairness.gateAdmissions !== false;
}
