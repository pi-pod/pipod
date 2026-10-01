/**
 * Fleet CPU fairness allocator worker (§7.3, parent review 2026-09-06).
 *
 * Every interval (default 15s) while `CPU_FAIRNESS_ENABLED=true`, and only
 * while holding the durable leader lease (`grant_allocator_lease`):
 *
 * 1. probes active hosts for versioned capacity (CPU budget, fairness mode,
 *    tenancy debt). Unreachable hosts, legacy hosts without a contract, and
 *    hosts with owner-migration debt are excluded from the solve — their
 *    tenants keep the conservative local fallback, never a fabricated grant;
 * 2. reads live sandbox placement from the pods table (no migration implied)
 *    and the last host-confirmed grants from the ledger;
 * 3. solves topology-constrained max-min shares and applies them in phases:
 *    DECREASES first (pushed + host-confirmed), then INCREASES clamped to
 *    the post-decrease confirmed residuals — so freed CPU is only ever spent
 *    after it is confirmed free, and every host sum stays within budget at
 *    every step. On push timeout/crash the old confirmed values stay charged
 *    (durable), never a post-RPC aspiration;
 * 4. records intent (desired) at allocate time and confirmation only on
 *    host-200 for the exact allocated revision (stale confirmations cannot
 *    overwrite newer state). 409 stale_revision adopts the host's revision
 *    floor and skips the pair for the tick.
 *
 * Partition behavior: grant-push failures are logged + counted, existing
 * sandboxes keep running on the local fallback, and hosts that report
 * `degraded` gate NEW admissions (server-side, in placement) until the
 * allocator recovers. Nothing is killed, frozen, or granted unlimited CPU.
 *
 * Demand input is live-sandbox count × 2 cores (ceiling proxy) until the
 * usage feed (workstream 6) supplies measured runnable demand — documented
 * approximation, re-solved every interval so errors self-correct.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { SandboxApiError } from "../../core/providers/sandbox/client.js";
import { query } from "../db/index.js";
import { sanitizeFailureMessage } from "../safe-errors.js";
import { observeCpuGrant } from "../metrics.js";
import {
  acquireAllocatorLease,
  adoptHostRevision,
  allocateGrantRevision,
  confirmGrant,
  cpuFairnessConfig,
  fitIncreasesToConfirmed,
  grantRefreshDue,
  markGrantsExpired,
  markGrantStale,
  planGrantPhases,
  readConfirmedGrants,
  solveCpuShares,
  type FairnessHostBudget,
  type FairnessUserDemand,
  type GrantPhaseItem,
  type WaitStore,
} from "../pods/cpu-fairness.js";
import { AWAKE_POD_SQL } from "../pods/concurrency.js";
import { platformToken } from "../pods/operations.js";
import { ownerKeyForUserId } from "../pods/owner-identity.js";
import { tenancyDebt } from "../pods/capacity.js";
import { FLEET_SWEEP_PROBE_CONCURRENCY, listDiallableSandboxHosts, probeSandboxHosts, sandboxFleetClient } from "../pods/sandboxfleet.js";

const store: WaitStore = {
  query: (text: string, params?: unknown[]) => query(text, params ?? []),
};

/** Live provider states: the sandbox exists under a tenant cgroup right now. */
const LIVE_GRANT_STATES = ["starting", "started"] as const;

/** This process's lease identity (stable per process, unique per worker). */
const LEASE_HOLDER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
let lastLeaseNote: string | null = null;

/**
 * Immediate wake for fairness bootstrap (§7.3, W12).
 *
 * The allocator tick is interval-driven (default 15s), but a provisioning
 * waiter that just enqueued on `fairness_degraded` needs its bootstrap
 * grant before its first re-probe: the waiter calls
 * `requestCpuAllocatorWake` and the scheduler-registered listener runs a
 * tick now instead of at the next interval boundary. Best-effort and
 * strictly in-process — a scheduler must register via `onCpuAllocatorWake`
 * (workers/index.ts does); split-role deployments without a local
 * scheduler still converge on the interval tick, and the leader lease
 * serializes a woken tick against a concurrent interval tick. A listener
 * that throws never breaks the waiter: failures are swallowed here.
 */
type CpuAllocatorWakeListener = () => void;
const wakeListeners = new Set<CpuAllocatorWakeListener>();

export function onCpuAllocatorWake(listener: CpuAllocatorWakeListener): () => void {
  wakeListeners.add(listener);
  return () => {
    wakeListeners.delete(listener);
  };
}

/**
 * Ask a locally scheduled allocator to tick now (fairness bootstrap).
 * Returns true when at least one scheduler is listening. Never throws and
 * never blocks: the tick itself runs asynchronously on the scheduler.
 */
export function requestCpuAllocatorWake(_reason: string): boolean {
  if (wakeListeners.size === 0) return false;
  for (const listener of [...wakeListeners]) {
    try {
      listener();
    } catch {
      // One bad listener must not break the waiter or the other schedulers.
    }
  }
  return true;
}

export async function runCpuAllocator(deps: {
  kek?: import("../secrets/crypto.js").KekProvider;
  env: Record<string, unknown>;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}): Promise<void> {
  const config = cpuFairnessConfig(deps.env);
  if (!config.enabled) return;
  try {
    // Boot snapshot, never ambient mid-tick: a BYO credential overlay
    // installs another org's key under this variable while provider calls
    // are in flight (see providercred chain docs).
    const token = platformToken(deps.env);

    // Leadership first: without the lease this tick only observes. TTL covers
    // the interval with margin; a crashed holder lapses and the next tick wins.
    const leased = await acquireAllocatorLease(store, {
      holder: LEASE_HOLDER,
      ttlMs: config.intervalMs * 2 + 30_000,
    }).catch(() => false);
    if (!leased) {
      if (lastLeaseNote !== "standby") {
        deps.log.info("cpu allocator standing by: leader lease held elsewhere");
        lastLeaseNote = "standby";
      }
      observeCpuGrant("skipped");
      return;
    }
    lastLeaseNote = "leader";

    // M6/M10: scope the sweep to diallable hosts IN SQL (static + vendor-
    // running) so thousands of stopped rows are never pulled, and bound the
    // probe fan-out so the tick cannot open one connection per host.
    const hosts = await listDiallableSandboxHosts("active");
    if (hosts.length === 0) return;
    const probed = await probeSandboxHosts(hosts, { kek: deps.kek, platformToken: token }, { maxConcurrency: FLEET_SWEEP_PROBE_CONCURRENCY });
    const urlToId = new Map(hosts.filter((host) => !host.owner_user_id).map((host) => [host.hosted_url ?? host.url, host.id]));


    // Solve inputs: reachable + contract + debt-free hosts only. Owner debt
    // (unowned rows competing with whole tenants) excludes a host until the
    // owner-init sweep drains it — granting around unknown tenants would bake
    // in the unfairness the grants exist to remove.
    const budgets = new Map<string, number>();
    const solvable: FairnessHostBudget[] = [];
    for (const candidate of probed) {
      const report = candidate.capacity;
      if (!candidate.reachable || !report) {
        observeCpuGrant("skipped");
        continue;
      }
      const debt = tenancyDebt(report);
      if (debt === null || debt > 0) {
        // Operator split: how much of the pending-init queue is logically
        // hidden (`archived`) vs `active`. Best-effort single grouped count —
        // a DB failure must never break the tick, so it degrades to no suffix.
        let queueNote = "";
        if (debt !== null) {
          const queue = await query<{ state: string; n: string }>(
            `SELECT p.state, count(*) AS n
               FROM pods p
               LEFT JOIN pod_owner_init q ON q.pod_id = p.id AND q.status = 'done'
              WHERE p.provider = 'sandbox'
                AND p.state IN ('active', 'archived')
                AND p.provider_state IN ('stopped', 'archived', 'error')
                AND p.provider_sandbox_id IS NOT NULL
                AND (p.sandbox_host_id = $2 OR (p.sandbox_host_id IS NULL AND $3::boolean AND p.resolved_config #>> '{config,providers,sandbox,url}' = $1))
                AND q.pod_id IS NULL
              GROUP BY p.state`,
            [candidate.host.hosted_url ?? candidate.host.url, candidate.host.id, !candidate.host.owner_user_id],
          ).catch(() => null);
          if (queue) {
            let active = 0;
            let hidden = 0;
            for (const row of queue.rows) {
              if (row.state === "archived") hidden += Number(row.n);
              else active += Number(row.n);
            }
            queueNote = ` (sweep queue: ${active} active, ${hidden} hidden)`;
          }
        }
        deps.log.warn(
          debt === null
            ? `cpu allocator skipping ${candidate.host.id}: no tenancy report (unknown owner debt)`
            : `cpu allocator skipping ${candidate.host.id}: ${debt} unowned sandbox(es) pending owner init${queueNote}`,
        );
        observeCpuGrant("skipped");
        continue;
      }
      // Floor admission cannot uphold ceiling-based grants under concurrency:
      // granting around floor accounting would silently overbook the host.
      if (report.capabilities.memoryAdmission !== "ceiling") {
        deps.log.warn(
          `cpu allocator skipping ${candidate.host.id}: memory admission is floor, not ceiling`,
        );
        observeCpuGrant("skipped");
        continue;
      }
      budgets.set(candidate.host.id, report.cpu.budgetCores);
      solvable.push({ hostId: candidate.host.id, budgetCores: report.cpu.budgetCores, reachable: true });
    }

    // A refused wake rolls back its quota claim to stopped/archived between
    // attempts. Its bounded, pinned wake wait is bootstrap demand, NOT live
    // compute or a quota claim. Without it a grantless cold tenant deadlocks:
    // start needs a grant, but the allocator never sees an awake sandbox.
    const wakeBootstrapSql = `provider_sandbox_id IS NOT NULL
      AND provider_state IN ('stopped', 'archived')
      AND EXISTS (SELECT 1 FROM pod_capacity_wait w
        WHERE w.pod_id = pods.id AND w.kind = 'wake'
          AND w.status = 'waiting' AND w.deadline_at > now())`;
    // Keep AWAKE_POD_SQL unchanged: every existing quota holder remains
    // grant-charged, with bounded wake bootstrap added on its frozen host.
    const live = await query<{ user_id: string; sandbox_host_id: string | null; url: string; live_n: string; bootstrap_n: string; charged_n: string }>(
      `SELECT user_id, sandbox_host_id, resolved_config #>> '{config,providers,sandbox,url}' AS url,
              count(*) FILTER (WHERE provider_state IN (${LIVE_GRANT_STATES.map((state) => `'${state}'`).join(",")})) AS live_n,
              count(*) FILTER (WHERE (provider_sandbox_id IS NULL
                AND provider_state IN ('preparing_image', 'provisioning'))
                OR (${wakeBootstrapSql})) AS bootstrap_n,
              count(*) AS charged_n
         FROM pods
        WHERE provider = 'sandbox' AND state = 'active'
          AND ((${AWAKE_POD_SQL}) OR (${wakeBootstrapSql}))
        GROUP BY user_id, sandbox_host_id, url`,
    );
    // Per (user, host) on solvable platform hosts only. Three disjoint roles:
    // - live demand (starting/started) sizes the grant (2-core proxy each);
    // - bootstrap demand (accepted/provisioning with an authoritative frozen
    //   host URL but no sandbox id yet) sizes one standard share so the FIRST
    //   grant exists before the first create — without it a managed-mode host
    //   refuses the new owner's create (fairness_degraded) and no grant ever
    //   follows (deadlock). Bounded stopped/archived wake waits likewise
    //   bootstrap on their pinned host. The wait retries until the grant lands.
    // - charged (any quota-holding row: stopping, error-with-sandbox,
    //   unknown, transitional) keeps its finite cap: revocation to
    //   weights-only (null = NO cap) is allowed ONLY with zero charged rows
    //   on that host. A stopping/error workload that is still burning CPU
    //   must never become uncapped just because it left starting/started.
    const perUser = new Map<string, Map<string, { live: number; bootstrap: number; charged: number }>>();
    for (const row of live.rows) {
      const hostId = row.sandbox_host_id ?? urlToId.get(row.url);
      if (!hostId || !budgets.has(hostId)) continue;
      let entry = perUser.get(row.user_id);
      if (!entry) {
        entry = new Map();
        perUser.set(row.user_id, entry);
      }
      // URL remains a SQL grouping key for unmapped legacy rows. Several
      // cached URLs (and legacy rows) can resolve to the same stable host.
      const previous = entry.get(hostId);
      entry.set(hostId, {
        live: (previous?.live ?? 0) + Number(row.live_n),
        bootstrap: (previous?.bootstrap ?? 0) + Number(row.bootstrap_n),
        charged: (previous?.charged ?? 0) + Number(row.charged_n),
      });
    }
    // Canonical input order (sorted ids) for cross-tick solve stability.
    // Charged-but-demandless users are intentionally ABSENT from the solve:
    // they hold their confirmed cap (no desired row means hold) instead of
    // being resized on zero demand.
    const chargedByPair = new Map<string, boolean>();
    for (const [userId, counts] of perUser) {
      for (const [hostId, n] of counts) {
        if (n.charged > 0) chargedByPair.set(`${hostId}|${ownerKeyForUserId(userId)}`, true);
      }
    }
    const users: FairnessUserDemand[] = [...perUser.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([userId, counts]) => {
        const hostIds = [...counts.keys()].sort();
        const sandboxesPerHost: Record<string, number> = {};
        let demand = 0;
        for (const [hostId, n] of counts) {
          sandboxesPerHost[hostId] = n.live + n.bootstrap;
          // Ceiling proxy until measured demand lands (workstream 6): 2 cores
          // per live sandbox plus one standard share per bootstrapping pod.
          demand += n.live * 2;
          if (n.live === 0 && n.bootstrap > 0) demand += 2;
        }
        if (demand <= 0) return [];
        return [{ userKey: ownerKeyForUserId(userId), demandCores: demand, hostIds, sandboxesPerHost }];
      });

    const desired = solveCpuShares({ users, hosts: solvable });
    const confirmed = await readConfirmedGrants(store);
    // Revocation: confirmed holders with no live demand release to
    // weights-only (null) — but ONLY with zero charged rows on that host.
    // A stopping/error/unknown workload still burns CPU: revoking it to an
    // uncapped state would un-cap live work. Charged holders simply hold.
    const desiredKeys = new Set(desired.map((share) => `${share.hostId}|${share.userKey}`));
    for (const grant of confirmed) {
      if (grant.confirmedCpuCores === null || grant.confirmedCpuCores <= 1e-9) continue;
      if (!budgets.has(grant.hostId)) continue;
      if (desiredKeys.has(`${grant.hostId}|${grant.userKey}`)) continue;
      if (chargedByPair.get(`${grant.hostId}|${grant.userKey}`)) continue;
      desired.push({ userKey: grant.userKey, hostId: grant.hostId, cpuCores: null });
    }
    const { decreases, increases } = planGrantPhases({ desired, confirmed });
    // TTL refresh: holds (desired ≈ confirmed) still need re-pushes before
    // the host-side TTL lapses, or the host falls back while the ledger
    // claims the old cap. Refreshes ride phase 1 (same cores, no residual).
    const nowMs = Date.now();
    const phaseKeys = new Set(
      [...decreases, ...increases].map((item) => `${item.hostId}|${item.userKey}`),
    );
    const refreshes: GrantPhaseItem[] = [];
    for (const grant of confirmed) {
      if (grant.confirmedCpuCores === null) continue;
      if (!budgets.has(grant.hostId)) continue;
      if (phaseKeys.has(`${grant.hostId}|${grant.userKey}`)) continue;
      if (!grantRefreshDue(grant, config.grantTtlMs, nowMs)) continue;
      refreshes.push({
        hostId: grant.hostId,
        userKey: grant.userKey,
        desired: grant.confirmedCpuCores,
        confirmed: grant.confirmedCpuCores,
      });
    }

    const push = async (item: GrantPhaseItem, cores: number | null): Promise<boolean> => {
      const target = hosts.find((host) => host.id === item.hostId);
      const client = target ? await sandboxFleetClient(target, { kek: deps.kek, platformToken: token }).catch(() => null) : null;
      if (!client) return false;
      // Native requires null or finite > 0: floor tiny positives so rounding
      // can never emit a 400-triggering 0 (documented 0.001 over-budget max).
      const rounded = cores === null ? null : Math.max(0.001, Math.round(cores * 1000) / 1000);
      const fail = async (): Promise<false> => {
        observeCpuGrant("failed");
        // The host is on its bounded fallback (or unreachable), NOT on our
        // confirmed values: mark stale so phase-2 defers new spending here
        // while confirmed stays charged. Never clears confirmed state.
        await markGrantStale(store, { hostId: item.hostId, userKey: item.userKey }).catch(() => {});
        return false;
      };      let revision: number;
      try {
        // Intent is ledger-durable BEFORE the RPC: a crash after this point
        // retries the same desired revision next tick (idempotent by revision).
        revision = await allocateGrantRevision(store, {
          hostId: item.hostId,
          userKey: item.userKey,
          nowMs: Date.now(),
          cpuCores: rounded,
          ttlMs: config.grantTtlMs,
        });
      } catch (e) {
        observeCpuGrant("failed");
        deps.log.warn(sanitizeFailureMessage(e, { prefix: `cpu grant allocate for ${item.hostId} failed` }));
        await markGrantStale(store, { hostId: item.hostId, userKey: item.userKey }).catch(() => {});
        return false;
      }
      try {
        await client.setCpuGrant(item.userKey, { revision, cpuCores: rounded, ttlMs: config.grantTtlMs });
      } catch (e) {
        if (e instanceof SandboxApiError && (e.status === 409 || e.code === "stale_revision")) {
          // Another controller won: adopt the host's floor, keep our confirmed
          // charged, skip the pair this tick. The next allocate() exceeds it.
          try {
            const tenant = await client.getTenantStatus(item.userKey).catch(() => null);
            const hostRev = tenant?.grant?.revision;
            if (typeof hostRev === "number") {
              await adoptHostRevision(store, { hostId: item.hostId, userKey: item.userKey, hostRevision: hostRev });
            }
          } catch {
            // Adopt is best-effort; the next allocate still bumps past.
          }
          observeCpuGrant("skipped");
          deps.log.warn(`cpu grant for ${item.hostId} lost a revision race; adopted host floor`);
          return false;
        }
        // Transport/5xx: the grant may or may not have landed — confirmed
        // stays at its old (higher, on decreases) value, which is the safe
        // direction, and the pair goes stale so no new spending plans
        // against it. Next tick replays the desired revision (host dedupes by
        // revision: same revision + same cores is idempotent).
        observeCpuGrant("failed");
        deps.log.warn(sanitizeFailureMessage(e, { prefix: `cpu grant push for ${item.hostId} failed` }));
        return await fail();
      }
      // Host-200 for the exact allocated revision: now (and only now) confirm.
      const ok = await confirmGrant(store, {
        hostId: item.hostId,
        userKey: item.userKey,
        revision,
        cpuCores: rounded,
      }).catch(() => false);
      if (ok) observeCpuGrant("issued");
      else observeCpuGrant("failed");
      return ok;
    };

    // Phase 1: decreases + TTL refreshes first — freed CPU must be confirmed
    // free before use, and refreshes keep effective == confirmed (no silent
    // fallback while the ledger claims the old cap).
    for (const item of [...decreases, ...refreshes]) {
      await push(item, item.desired);
    }
    // Phase 2: increases clamped to post-decrease confirmed residuals, so the
    // tick can never spend CPU a failed decrease did not actually free.
    // Stale hosts (fallback, not confirmed values) defer all increases.
    const confirmedAfter = await readConfirmedGrants(store);
    const confirmedTotals = new Map<string, number>();
    const staleHosts = new Set<string>();
    for (const grant of confirmedAfter) {
      if (grant.freshness === "stale") staleHosts.add(grant.hostId);
      if (grant.confirmedCpuCores === null) continue;
      if (!budgets.has(grant.hostId)) continue;
      confirmedTotals.set(grant.hostId, (confirmedTotals.get(grant.hostId) ?? 0) + grant.confirmedCpuCores);
    }
    const fitted = fitIncreasesToConfirmed({ increases, confirmedTotals, budgets, staleHosts });
    const deferred = increases.length - fitted.length;
    for (const item of fitted) {
      await push(item, item.desired);
    }
    const refreshed = refreshes.length;
    if (decreases.length > 0 || fitted.length > 0 || deferred > 0 || refreshed > 0) {
      deps.log.info(
        `cpu allocator tick: ${decreases.length} decrease(s), ${fitted.length} increase(s), ${refreshed} refresh(es)` +
          (deferred > 0 ? `, ${deferred} deferred to next tick` : "") +
          (staleHosts.size > 0 ? `, stale: ${[...staleHosts].sort().join(",")}` : ""),
      );
    }
  } catch (e) {
    observeCpuGrant("failed");
    deps.log.error(sanitizeFailureMessage(e, { prefix: "cpu allocator failed" }));
  }
}
