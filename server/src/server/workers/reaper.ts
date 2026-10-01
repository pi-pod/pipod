import { hostForPod, hostCanDial } from "../pods/hostidentity.js";
import { query } from "../db/index.js";
import { startedHostChildIds, withPodSandbox } from "../pods/lifecycle.js";
import { getPod, runProviderPodCommand, type PodRow } from "../pods/service.js";
import { withProviderCredential } from "../pods/providercred.js";
import { effectiveDelayForPod, readRetentionRecord } from "../pods/retention-policy.js";
import type { WorkerDeps } from "./index.js";

/**
 * Atomically move every currently idle pod into the provider stop transition. Gateway ownership
 * is deliberately irrelevant: attached users and semantic work are represented by activity and
 * work leases, while a fresh gateway heartbeat can belong to a detached replacement session.
 *
 * A logically archived pod is claimed without waiting for any of that. `POST /pods/:id/archive`
 * only writes the logical state, leaving the sandbox for this sweep to stop — but an archived pod
 * refuses every request until it is restored, so idleness is not a question worth asking about
 * one. Waiting for it stranded archived pods at the provider indefinitely whenever something kept
 * refreshing their activity, running (and billing, and holding a concurrency slot) for a session
 * nobody could reach.
 */
export async function claimNextIdlePod(candidateIds: readonly string[] | null = null): Promise<PodRow | null> {
  const claimed = await query<PodRow>(
    `WITH eligible AS (
       SELECT id FROM pods
       WHERE ($1::uuid[] IS NULL OR id = ANY($1))
         AND provider_state = 'started'
         AND NOT EXISTS (SELECT 1 FROM sandbox_hosts sh WHERE sh.id = pods.sandbox_host_id
           AND sh.boat_state IS NOT NULL AND sh.boat_state <> 'running')
         AND (
           state = 'archived'
           OR (
             (resolved_config->'config'->>'idleTimeoutMinutes')::int > 0
             AND (work_lease_until IS NULL OR work_lease_until <= now())
             AND COALESCE(last_activity_at, created_at)
                 < now() - make_interval(mins => (resolved_config->'config'->>'idleTimeoutMinutes')::int)
             -- A host is idle only when everything on its machine is: a busy or recently
             -- active co-located child holds the machine open, measured against the host's
             -- own idle window (children carry idleTimeoutMinutes 0 and are never claimed).
             AND NOT EXISTS (
               SELECT 1 FROM pods child
               WHERE child.host_pod_id = pods.id
                 AND child.provider_state IN ('started', 'starting')
                 AND (
                   child.work_lease_until > now()
                   OR COALESCE(child.last_activity_at, child.created_at)
                      >= now() - make_interval(mins => (pods.resolved_config->'config'->>'idleTimeoutMinutes')::int)
                 )
             )
           )
         )
       ORDER BY COALESCE(last_activity_at, created_at), id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE pods AS pod SET provider_state = 'stopping', provider_state_changed_at = now(),
       last_stop_cause = CASE WHEN pod.state = 'archived' THEN 'archived' ELSE 'idle_stop' END,
       state_reason = CASE WHEN pod.state = 'archived' THEN 'archived' ELSE 'idle_stop' END,
       work_lease_until = NULL, updated_at = now()
     FROM eligible
     WHERE pod.id = eligible.id
     RETURNING pod.*`,
    [candidateIds],
  );
  return claimed.rows[0] ?? null;
}

/**
 * Idle reaping and archive sweeps (spec §8, §12): the server owns the idle policy now —
 * the resolved config the pod launched with is the authority.
 */
export async function runIdleReaper(deps: WorkerDeps): Promise<void> {
  const candidates = await query<{ id: string }>(`SELECT id FROM pods WHERE provider_state = 'started'`);
  const remaining = candidates.rows.map((row) => row.id);
  while (remaining.length > 0) {
    const pod = await claimNextIdlePod(remaining);
    if (!pod) return;
    remaining.splice(remaining.indexOf(pod.id), 1);
    // The claim already recorded why this pod is leaving `started`; a session closed with the
    // cause the row carries tells the client the same story the pod list will.
    const cause = pod.last_stop_cause ?? "idle_stop";
    try {
      if (deps.gateway) {
        const closing = [pod.id, ...(await startedHostChildIds(pod.id).catch(() => []))];
        for (const podId of closing) {
          await deps.gateway
            .closePod(podId, podId === pod.id ? cause : "host_stopped")
            .catch((e) => deps.log.warn(`idle reaper: could not close gateway session for ${podId}: ${e instanceof Error ? e.message : e}`));
        }
      }
      await runProviderPodCommand(
        { env: deps.env, kek: deps.kek, log: deps.log },
        pod,
        "stop",
        null,
        { alreadyClaimedFrom: "started" },
      );
      deps.log.info(`idle reaper stopped provider sandbox for ${cause === "archived" ? "archived" : "idle"} pod ${pod.id}`);
    } catch (e) {
      deps.log.warn(`idle reaper: pod ${pod.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/**
 * Archive sweep (plan §3.3): server-enforced stopped → archived using the versioned
 * effective retention (pod_retention row wins, launch report is legacy fallback).
 * Hidden rows (state=archived/provider_state=stopped) participate like any stopped pod;
 * the sweep never stops a running pod to archive it.
 *
 * Race safety: sandbox pods use archive-if-still-stopped with the authoritative stopped
 * timestamp. Older hosts without the route take the safe re-read fallback (DB + provider
 * both still stopped) instead of a blind force archive after a stale read. Reapplying
 * policy never resets provider_state_changed_at — only a real new stop does.
 */
export async function runArchiveSweep(deps: WorkerDeps): Promise<void> {
  // Overdue-first, sequential (rate-limited): an overdue wave from a policy cut archives
  // one pod at a time instead of one unbounded storage job.
  const rows = await query<PodRow>(
    `SELECT * FROM pods
     WHERE provider_state = 'stopped'
     ORDER BY provider_state_changed_at, id`,
  );
  for (const pod of rows.rows) {
    try {
      const fresh = await getPod(pod.org_id, pod.id);
      if (fresh.provider_state !== "stopped") continue;
      const host = await hostForPod(fresh);
      // Personal Boat workspaces retain local disks across whole-host sleep.
      // Never apply normal timed archive, including legacy nonzero records.
      if (host?.owner_user_id != null || (host && !hostCanDial(host))) continue;
      const retention = fresh.resolved_config.retention;
      if (retention?.archiveTransition.kind === "same-as-stop") continue;
      if (retention && retention.effectiveArchiveAfterMinutes == null) continue;
      const record = await readRetentionRecord(fresh.id).catch(() => null);
      const archiveMinutes = effectiveDelayForPod(fresh, record);
      if (!(archiveMinutes > 0)) continue;
      const stoppedAt = Date.parse(fresh.provider_state_changed_at);
      if (!Number.isFinite(stoppedAt) || stoppedAt >= Date.now() - archiveMinutes * 60_000) continue;
      // Serialize with a concurrent wake: claim stopped → archiving under CAS. A wake
      // that won first leaves no row to claim, so the sweep never archives from under it.
      const claimed = await query(
        `UPDATE pods SET provider_state = 'archiving', provider_state_changed_at = provider_state_changed_at,
           updated_at = now() WHERE id = $1 AND provider_state = 'stopped' RETURNING id`,
        [fresh.id],
      );
      if ((claimed.rowCount ?? 0) !== 1) continue;
      const claimedRow = await getPod(fresh.org_id, fresh.id);
      let disposition: "archived" | "skipped" | "gone";
      try {
        disposition = await archiveStoppedPod(deps, claimedRow, archiveMinutes);
      } catch (e) {
        // Unexpected failure: return the claim so a later sweep or wake can proceed; the
        // stopped clock is preserved (provider_state_changed_at untouched) so the pod
        // stays due. (Expected skips and gone-convergence return normally, not via throw.)
        await query(
          `UPDATE pods SET provider_state = 'stopped', updated_at = now()
           WHERE id = $1 AND provider_state = 'archiving'`,
          [fresh.id],
        ).catch(() => {});
        throw e;
      }
      if (disposition === "skipped") {
        // Lost a race, host asked for a retry later, or the host needs an upgrade: give
        // the claim back and stay due (or not) per the preserved stopped clock.
        await query(
          `UPDATE pods SET provider_state = 'stopped', updated_at = now()
           WHERE id = $1 AND provider_state = 'archiving'`,
          [fresh.id],
        ).catch(() => {});
        continue;
      }
      if (retention?.archiveTransition.kind === "after-stop") {
        deps.log.info(
          disposition === "gone"
            ? `archive sweep found provider sandbox for logical pod ${pod.id} gone; row converged`
            : `archive sweep moved provider sandbox for logical pod ${pod.id} to cold storage`,
        );
      } else {
        deps.log.info(`archive sweep applied logical archive for pod ${pod.id}`);
      }
    } catch (e) {
      deps.log.warn(`archive sweep: pod ${pod.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/**
 * Archive one claimed (stopped → archiving) pod.
 *
 * Race safety (plan §3.3, parent correction A): the conditional route is guarded by
 * HOST-ISSUED values fetched via GET sandbox — expectedRevision is the host's transition
 * revision (never pod_retention.revision: different domains) and expectedStoppedAt is the
 * host's authoritative stoppedAt (never the server clock). The host's stop age is
 * revalidated against the effective delay, so a stale DB due-date cannot archive a
 * freshly re-stopped sandbox after an out-of-band wake/stop the DB has not converged yet.
 *
 * Compatibility (parent correction E): hosts predating archive-if-stopped are SKIPPED
 * (claim restored, upgrade warning), never force-archived. Non-sandbox providers keep
 * their pre-existing re-read-then-archive path — out of this workstream's scope.
 */
async function archiveStoppedPod(
  deps: WorkerDeps,
  pod: PodRow,
  effectiveMinutes: number,
): Promise<"archived" | "skipped" | "gone"> {
  const sandboxDeps = { env: deps.env, kek: deps.kek, log: deps.log };
  const finish = async (state: "archived" | "gone"): Promise<"archived" | "gone"> => {
    const { cascadeHostChildrenRows } = await import("../pods/lifecycle.js");
    const { audit } = await import("../audit.js");
    await query(
      state === "archived"
        ? `UPDATE pods SET provider_state = 'archived', provider_state_changed_at = now(), state_reason = NULL,
             updated_at = now() WHERE id = $1 AND provider_state = 'archiving'`
        : `UPDATE pods SET provider_state = 'gone', provider_state_changed_at = now(),
             state_reason = 'the provider no longer knows this sandbox', reaped_at = now(), updated_at = now()
           WHERE id = $1 AND provider_state = 'archiving'`,
      [pod.id],
    );
    await cascadeHostChildrenRows(pod.id, state === "gone" ? "gone" : "archived").catch(() => {});
    await audit({
      orgId: pod.org_id,
      actorId: null,
      action: state === "gone" ? "pod.provider_gone" : "pod.provider_archive",
      targetType: "pod",
      targetId: pod.id,
    }).catch(() => {});
    return state;
  };

  try {
    const outcome = await withPodSandbox(sandboxDeps as never, pod, async (sandbox) => {
      const handle = sandbox as unknown as {
        archiveIfStopped?: (opts: {
          timeoutMs: number;
          expectedRevision?: number;
          expectedStoppedAt?: string;
        }) => Promise<{ archived: boolean; outcome: string }>;
        fetchInfo?: () => Promise<{
          state: string;
          revision?: number;
          stoppedAt?: string | null;
        }>;
      };
      if (typeof handle.archiveIfStopped !== "function") {
        // Non-sandbox provider: pre-existing path (out of scope). Re-read provider state
        // immediately before archiving so a wake that landed after the DB claim still wins.
        const state = await sandbox.state().catch(() => null);
        if (state === "gone") return { done: "gone" as const };
        if (state !== "stopped") return { done: "skipped" as const, reason: "not_stopped" };
        await sandbox.archive(300_000);
        return { done: "archived" as const };
      }
      // Sandbox host: fetch host-issued guards first.
      let info: { state: string; revision?: number; stoppedAt?: string | null } | null = null;
      try {
        info = typeof handle.fetchInfo === "function"
          ? await handle.fetchInfo()
          : { state: await sandbox.state() };
      } catch (e) {
        if (e instanceof Error && /no longer knows|not found|gone/i.test(e.message)) {
          return { done: "gone" as const };
        }
        throw e;
      }
      if (info === null || info.state === "gone") return { done: "gone" as const };
      if (info.state !== "stopped") return { done: "skipped" as const, reason: "not_stopped" };
      if (typeof info.revision !== "number") {
        // Host predates the conditional route: SKIP (fail closed) until it upgrades.
        // Never force-archive on a stale read (parent correction E).
        deps.log.warn(
          `archive sweep: pod ${pod.id} host predates archive-if-stopped; skipping until the host upgrades`,
        );
        return { done: "skipped" as const, reason: "host-upgrade-needed" };
      }
      // Revalidate the HOST's stop age: a stale DB due-date must not archive a sandbox
      // that was woken and re-stopped out of band after the DB row went stale.
      if (typeof info.stoppedAt === "string" && Number.isFinite(Date.parse(info.stoppedAt))) {
        if (Date.parse(info.stoppedAt) >= Date.now() - effectiveMinutes * 60_000) {
          return { done: "skipped" as const, reason: "host-stop-too-fresh" };
        }
      } else if (info.stoppedAt !== null && info.stoppedAt !== undefined) {
        return { done: "skipped" as const, reason: "host-stop-unknown" };
      }
      // info.stoppedAt null on a conditional-capable host: no authoritative stop instant
      // recorded — fail closed and retry later rather than archiving blind.
      if (info.stoppedAt == null) {
        return { done: "skipped" as const, reason: "host-stop-unknown" };
      }
      let conditional: { archived: boolean; outcome: string };
      try {
        conditional = await handle.archiveIfStopped({
          timeoutMs: 300_000,
          expectedRevision: info.revision,
          expectedStoppedAt: info.stoppedAt,
        });
      } catch (e) {
        if (e instanceof Error && /archive_unsupported|predates archive-if-stopped/.test(e.message)) {
          deps.log.warn(
            `archive sweep: pod ${pod.id} host predates archive-if-stopped; skipping until the host upgrades`,
          );
          return { done: "skipped" as const, reason: "host-upgrade-needed" };
        }
        throw e;
      }
      if (conditional.archived || conditional.outcome === "already_archived") {
        return { done: "archived" as const };
      }
      if (
        conditional.outcome === "not_stopped" ||
        conditional.outcome === "revision_mismatch" ||
        conditional.outcome === "transitioning"
      ) {
        // Lost a race to a wake/transition — caller restores the stopped claim.
        return { done: "skipped" as const, reason: conditional.outcome };
      }
      if (conditional.outcome === "archive_busy") {
        return { done: "skipped" as const, reason: "archive_busy" };
      }
      throw new Error(`archive skipped: ${conditional.outcome}`);
    }, { recoverStaleProviderState: false } as never);
    if (outcome.done === "archived") return finish("archived");
    if (outcome.done === "gone") return finish("gone");
    throw new Error(`archive skipped: ${outcome.reason ?? "unknown"}`);
  } catch (e) {
    // withPodSandbox throws when the pod has no sandbox id or the provider is gone.
    if (e instanceof Error && /no longer knows this pod|provider no longer knows/.test(e.message)) {
      return finish("gone");
    }
    throw e;
  }
}
