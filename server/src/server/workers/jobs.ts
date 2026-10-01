import { randomUUID } from "node:crypto";
import { query, tx } from "../db/index.js";
import { HttpError } from "../httperrors.js";
import { edition, ownedHosts } from "../edition.js";
import type { ServerEnv } from "../env.js";
import type { GatewayService } from "../gateway/service.js";
import { uuidv7 } from "../ids.js";
import { getPod, launchPod } from "../pods/service.js";
import type { KekProvider } from "../secrets/crypto.js";
import { jobIncludesUserBundle, nextOccurrenceAt, parseModelRef, type JobRow } from "../jobs/store.js";
import { observeJobRun, trackWorkerTick } from "../metrics.js";
import { enqueuePush } from "../push/queue.js";
import { readLayer } from "../settings/merge.js";
import { launchGateIsOpen } from "../pods/launch-control.js";

const LAUNCH_TIMEOUT_MS = 10 * 60_000;
const MAX_PROMPTED_RUN_HOURS = 24;
const POLL_MS = 5_000;
const SCHEDULE_MS = 30_000;
// Claim only work this gateway can start immediately; a claimed run must never sit behind
// another ten-minute provisioning wait and be abandoned by a peer.
const DUE_BATCH = 1;

export interface JobSchedulerDeps {
  env: ServerEnv;
  kek: KekProvider;
  gateway: GatewayService;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

interface ClaimedRun {
  job: JobRow;
  runId: string;
  scheduledAt: string;
}

/** Jobs need the live RPC channel, so their scheduler belongs on gateway-role instances.
 * Every gateway runs this loop; row locks and SKIP LOCKED divide due work safely. */
export function startJobScheduler(deps: JobSchedulerDeps): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await trackWorkerTick("job-scheduler", () => runJobScheduler(deps));
    } catch (e) {
      deps.log.error(`job scheduler: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), SCHEDULE_MS);
  void tick();
  return () => clearInterval(timer);
}

/** Atomically advance each schedule and create its durable run before any provider work. */
export async function runJobScheduler(deps: JobSchedulerDeps): Promise<void> {
  if (!(await launchGateIsOpen())) return;
  await failAbandonedLaunches();
  const boat = ownedHosts(deps.env);
  const claims = await claimDueRuns(DUE_BATCH, boat);
  if (boat) { await runPendingBoatJobs(deps); return; }
  // One immediate claim per gateway bounds outage/backlog cost and avoids queued claims.
  for (const claim of claims) {
    await executeJob(deps, claim).catch((e) => {
      deps.log.error(
        `job ${claim.job.id} (${claim.job.name}): ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
}

export async function claimDueRuns(limit: number, waitForBoat = false): Promise<ClaimedRun[]> {
  return tx(async (client) => {
    const now = await client.query<{ now: string | Date }>("SELECT now() AS now");
    const databaseNow = new Date(now.rows[0]!.now);
    const due = await client.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'active' AND archived_at IS NULL AND next_run_at <= now()
       ORDER BY next_run_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [limit],
    );
    const claims: ClaimedRun[] = [];
    for (const job of due.rows) {
      const scheduledAt = job.next_run_at!;
      // Skip missed occurrences after downtime instead of replaying a costly backlog. Both
      // due-ness and the base timestamp come from Postgres, avoiding application clock skew.
      const base = new Date(Math.max(new Date(scheduledAt).getTime(), databaseNow.getTime()));
      const next = nextOccurrenceAt(job.trigger, base);
      const runId = uuidv7();
      await client.query(
        `INSERT INTO job_runs (id, job_id, org_id, scheduled_at,host_wait_state,host_wait_job,host_wait_deadline,host_wait_retry_at)
         VALUES ($1,$2,$3,$4,CASE WHEN $5 THEN 'waiting' END,$6,
           CASE WHEN $5 THEN now()+interval '30 minutes' END,CASE WHEN $5 THEN now() END)`,
        [runId, job.id, job.org_id, scheduledAt, waitForBoat, waitForBoat ? JSON.stringify(job) : null],
      );
      await client.query(
        `UPDATE jobs
         SET next_run_at = $2,
             last_run_at = $3,
             status = CASE WHEN $2::timestamptz IS NULL THEN 'completed' ELSE status END,
             updated_at = now()
         WHERE id = $1`,
        [job.id, next, scheduledAt],
      );
      claims.push({ job, runId, scheduledAt });
    }
    return claims;
  });
}

async function executeJob(deps: JobSchedulerDeps, claim: ClaimedRun): Promise<void | "host-wait"> {
  const { job, runId } = claim;
  let podId: string | null = null;
  let podFailedDuringLaunch = false;
  const live = await query(
    "UPDATE job_runs SET started_at = now() WHERE id = $1 AND status = 'running' RETURNING id",
    [runId],
  );
  if ((live.rowCount ?? 0) === 0) return;
  try {
    const { pod } = await launchPod(
      {
        env: deps.env,
        kek: deps.kek,
        log: deps.log,
        onPodCreated: async (createdPodId) => {
          podId = createdPodId;
          const linked = await query(
            "UPDATE job_runs SET pod_id = $2 WHERE id = $1 AND status = 'running' RETURNING id",
            [runId, createdPodId],
          );
          if ((linked.rowCount ?? 0) === 0) throw new Error("scheduled job run is no longer active");
        },
        onPodStarted: (startedPodId) => {
          void deps.gateway.ensureSession(job.org_id, startedPodId).catch(() => {});
        },
      },
      {
        orgId: job.org_id,
        userId: job.user_id,
        includeUserBundle: jobIncludesUserBundle(job),
        templateId: job.template_id,
        gatewayId: deps.env.GATEWAY_ID,
      },
    );
    podId = pod.id;
    await waitForStarted(job.org_id, pod.id);
    await deps.gateway.promptPod(job.org_id, pod.id, {
      jobRunId: runId,
      text: job.prompt,
      model: parseModelRef(job.model),
    });
    // Completion is recorded by GatewayService for this exact run at agent_settled, not
    // merely when the RPC prompt is accepted.
    deps.log.info(`job ${job.name} (${job.id}) prompted pod ${pod.id}`);
  } catch (e) {
    // This refusal is emitted before pod insertion; only this known safe boundary
    // may return to the same durable scheduled occurrence's host wait.
    if (ownedHosts(deps.env) && podId === null && hostStarting(e)) return "host-wait";
    const message = e instanceof Error ? e.message : String(e);
    if (podId) {
      const pod = await getPod(job.org_id, podId).catch(() => null);
      podFailedDuringLaunch = pod?.provider_state === "error";
    }
    const failed = await query(
      `UPDATE job_runs SET status = 'failed', error = $2, finished_at = now()
       WHERE id = $1 AND status = 'running'`,
      [runId, message.slice(0, 2000)],
    );
    // Count only the row this UPDATE actually moved, so a concurrent abandon cannot double-count.
    observeJobRun("failed", failed.rowCount ?? 0);
    // launchPod already sends the policy-redacted pod-error push for provisioning errors.
    if (!podFailedDuringLaunch) await pushJobFailure(job, podId, message);
    throw e;
  }
}

function hostStarting(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.statusCode !== 503) return false;
  const detail = error.detail as { retryable?: boolean; reason?: string } | undefined;
  return detail?.retryable === true && ["host_starting","boat_starts_disabled","host_requires_reconciliation"].includes(detail.reason ?? "");
}

/** Reclaim only pre-pod waits. The immutable occurrence/snapshot and lease fence
 * survive restart without advancing its schedule again. Dispatch is committed
 * before launch and is NEVER replayed after a crash/ambiguous pod creation. */
export async function runPendingBoatJobs(deps: JobSchedulerDeps): Promise<void> {
  await query(`UPDATE job_runs SET status='failed',error='workstation did not become ready before the scheduled host-wait deadline',finished_at=now()
    WHERE status='running' AND host_wait_state='waiting' AND host_wait_deadline<=now()
      AND (host_wait_lease_until IS NULL OR host_wait_lease_until<=now())`);
  await query(`UPDATE job_runs SET error='scheduled launch result is uncertain; operator reconciliation required'
    WHERE status='running' AND host_wait_state='dispatching' AND prompted_at IS NULL AND host_wait_lease_until<=now()`);
  const lease = randomUUID();
  const claimed = await tx(async client => {
    const result = await client.query<{id:string;host_wait_job:JobRow;scheduled_at:string;host_wait_fence:string}>(`WITH due AS (
      SELECT id FROM job_runs WHERE status='running' AND host_wait_state='waiting' AND pod_id IS NULL
        AND host_wait_deadline>now() AND host_wait_retry_at<=now()
        AND (host_wait_lease_until IS NULL OR host_wait_lease_until<=now())
      ORDER BY host_wait_retry_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE job_runs r SET host_wait_lease_owner=$1,host_wait_lease_until=now()+interval '2 minutes',host_wait_fence=host_wait_fence+1
      FROM due WHERE r.id=due.id RETURNING r.id,r.host_wait_job,r.scheduled_at,r.host_wait_fence`,[lease]);
    return result.rows[0];
  });
  if (!claimed) return;
  const pins=[claimed.id,lease,claimed.host_wait_fence];
  try {
    await edition().ensureOwnedHostReady(deps,claimed.host_wait_job.user_id);
  } catch (error) {
    if (hostStarting(error)) {
      await query(`UPDATE job_runs SET host_wait_retry_at=now()+interval '10 seconds',host_wait_lease_owner=NULL,host_wait_lease_until=NULL
        WHERE id=$1 AND host_wait_lease_owner=$2 AND host_wait_fence=$3 AND host_wait_lease_until>now() AND host_wait_state='waiting'`,pins);
      return;
    }
    await query(`UPDATE job_runs SET status='failed',error='scheduled workstation demand was refused',finished_at=now()
      WHERE id=$1 AND host_wait_lease_owner=$2 AND host_wait_fence=$3 AND host_wait_lease_until>now() AND host_wait_state='waiting'`,pins);
    return;
  }
  const dispatched=await query(`UPDATE job_runs SET host_wait_state='dispatching',error=NULL
    WHERE id=$1 AND status='running' AND pod_id IS NULL AND host_wait_state='waiting'
      AND host_wait_lease_owner=$2 AND host_wait_fence=$3 AND host_wait_lease_until>now() AND host_wait_deadline>now() RETURNING id`,pins);
  if (!dispatched.rowCount) return;
  const heartbeat=setInterval(()=>void query(`UPDATE job_runs SET host_wait_lease_until=now()+interval '2 minutes'
    WHERE id=$1 AND host_wait_lease_owner=$2 AND host_wait_fence=$3 AND host_wait_state='dispatching' AND status='running'`,pins).catch(()=>{}),30_000);
  try {
    const outcome=await executeJob(deps,{job:claimed.host_wait_job,runId:claimed.id,scheduledAt:claimed.scheduled_at});
    await query(`UPDATE job_runs SET host_wait_state=$4,error=NULL,host_wait_retry_at=now()+interval '10 seconds',host_wait_lease_owner=NULL,host_wait_lease_until=NULL
      WHERE id=$1 AND host_wait_lease_owner=$2 AND host_wait_fence=$3 AND host_wait_state='dispatching'`,[...pins,outcome==="host-wait"?"waiting":null]);
  } catch (error) {
    // executeJob has recorded a known terminal failure. A process crash instead
    // leaves dispatching for explicit reconciliation, never duplicate creation.
    await query(`UPDATE job_runs SET host_wait_state=NULL WHERE id=$1 AND host_wait_lease_owner=$2 AND host_wait_fence=$3 AND status='failed'`,pins);
    deps.log.warn(`scheduled Boat launch ${claimed.id} failed`);
  } finally {clearInterval(heartbeat);}
}

async function pushJobFailure(job: JobRow, podId: string | null, message: string): Promise<void> {
  const policy = await readLayer("org_policy", job.org_id, job.org_id).catch(() => null);
  // Privacy fails closed: if policy cannot be read, do not put names/errors on a lock screen.
  const redacted = policy === null
    ? true
    : ((policy.config as { notifications?: { redacted?: boolean } }).notifications?.redacted ?? false);
  await enqueuePush(job.user_id, {
    title: redacted ? "scheduled job failed" : `job failed: ${job.name}`,
    body: redacted ? "" : message.slice(0, 200),
    data: {
      ...(podId ? { pod_id: podId } : { job_id: job.id }),
      org_id: job.org_id,
      kind: "job_failed",
    },
  }).catch(() => {});
}

/** Crashes leave visible terminal runs instead of silently losing ticks forever. */
async function failAbandonedLaunches(): Promise<void> {
  const unprompted = await query(
    `UPDATE job_runs SET status = 'failed', error = 'scheduler stopped before prompt delivery', finished_at = now()
     WHERE status = 'running' AND prompted_at IS NULL AND host_wait_state IS NULL
       AND started_at < now() - make_interval(mins => $1)`,
    [Math.ceil(LAUNCH_TIMEOUT_MS / 60_000) + 5],
  );
  observeJobRun("failed", unprompted.rowCount ?? 0);
  const unsettled = await query(
    `UPDATE job_runs SET status = 'failed', error = 'agent did not settle before the run deadline', finished_at = now()
     WHERE status = 'running' AND prompted_at IS NOT NULL
       AND prompted_at < now() - make_interval(hours => $1)`,
    [MAX_PROMPTED_RUN_HOURS],
  );
  observeJobRun("failed", unsettled.rowCount ?? 0);
}

async function waitForStarted(orgId: string, podId: string): Promise<void> {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  for (;;) {
    const pod = await getPod(orgId, podId);
    if (pod.provider_state === "started") return;
    if (pod.provider_state === "error") {
      throw new Error(`pod launch failed: ${pod.state_reason ?? "unknown error"}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`pod ${podId} did not start within ${LAUNCH_TIMEOUT_MS / 60000} minutes`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
