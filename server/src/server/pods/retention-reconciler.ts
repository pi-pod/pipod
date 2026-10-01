/**
 * Operator retention reconciler (plan §3.2): `fleet retention plan|apply|status`.
 *
 * Inventory covers every native pod (`provider = 'sandbox'`, `provider_state <> 'gone'`),
 * INCLUDING logically hidden rows (`state=archived/provider_state=stopped` are not
 * corruption — their disks still consume capacity and participate in the same archive
 * policy). The migration never forces a hidden running pod to stop merely because it is
 * hidden.
 *
 * Custody scoping (plan §3.1): the deployment maximum applies to platform-funded pods
 * only. Custody comes from the pod_retention record (immutable launch fact, written by
 * provisioning); legacy rows without a record are resolved per org via the injected
 * resolver (the CLI builds it from the startup env + KEK, never by decrypting per row
 * inline). BYOK (`org-secret`) and unknown-custody rows are NEVER rewritten: the plan
 * marks them unscoped, apply backfills the record at most, and provider convergence is
 * skipped for them. The reaper treats unscoped records as advisory-only because their
 * desired value was resolved without the deployment maximum.
 *
 * Token discipline: the platform token is passed in once (startup snapshot), never read
 * from process.env inside this module — providercred swaps per-org BYO keys into that
 * variable under a lock, and reading it here could send another org's secret to a fleet
 * host or mis-attribute 401s.
 *
 * - plan: dry run. Shows logical state, provider state, custody, current provider delay,
 *   effective policy, stop timestamp, due time, and proposed action. Emits a stable
 *   migration id plus row versions. No secrets, no writes.
 * - apply: re-resolves every entry fresh at apply time (a plan is a view, not a lock —
 *   a policy change between plan and apply converges to the NEW value, never acks the
 *   stale revision), persists desired state transactionally (pod_retention upsert with
 *   revision guard + audit), then calls provider applyRetention with bounded
 *   concurrency. Equal values are success. Ambiguous timeouts re-read the provider
 *   before reporting convergence. Status acks carry WHERE revision = expected so a
 *   concurrent apply cannot ack another revision's work. Requires explicit --yes
 *   (operator approval). Never archives: overdue pods are left for the sequential
 *   sweep, and the result names the wave size.
 * - status: convergence counts + pending/failed rows + overdue wave size.
 */
import { SandboxClient } from "../../core/providers/sandbox/client.js";
import { query, tx, type Queryable } from "../db/index.js";
import { audit } from "../audit.js";
import { parseStoredPolicy, readLayer } from "../settings/merge.js";
import {
  platformArchiveMaxMinutes,
  resolveEffectiveRetention,
  type CredentialSource,
} from "./retention-policy.js";
import type { PodRow } from "./types.js";

export const RETENTION_MIGRATION_ID = "platform-60-v1";
const APPLY_CONCURRENCY = 5;

/** Custody of one pod as the reconciler sees it. `unknown` = fail closed (record only). */
export type Custody = CredentialSource | "unknown";

export type RetentionAction =
  | "none"
  | "backfill-record"
  | "update-retention"
  | "archive-due";

export interface RetentionPlanEntry {
  podId: string;
  orgId: string;
  logicalState: string;
  providerState: string;
  hostUrl: string | null;
  requestedMinutes: number;
  orgMaxMinutes: number | undefined;
  deploymentMaxMinutes: number;
  /** Deployment max participated (platform custody only). */
  scoped: boolean;
  custody: Custody;
  effectiveMinutes: number;
  providerMinutes: number | null;
  stoppedAt: string;
  dueAt: string | null;
  overdue: boolean;
  hasRecord: boolean;
  recordRevision: number | null;
  action: RetentionAction;
  detail: string;
}

export interface RetentionPlan {
  migrationId: string;
  generatedAt: string;
  deploymentMaxMinutes: number;
  entries: RetentionPlanEntry[];
  overdueCount: number;
}

import { hostForPod, hostCanDial } from "./hostidentity.js";
import { sandboxFleetClient, type SandboxHostRow, type FleetClientDeps } from "./sandboxfleet.js";

async function retentionClient(pod: PodRow, deps: FleetClientDeps): Promise<SandboxClient | null> {
  if (!deps.kek && !deps.platformToken) return null;
  const host = await hostForPod(pod);
  if (host) {
    if (!hostCanDial(host)) return null;
    return sandboxFleetClient(host as unknown as SandboxHostRow, deps);
  }
  const url = hostUrlOf(pod);
  return url && deps.platformToken ? new SandboxClient(url, deps.platformToken) : null;
}

export interface ReconcilerDeps extends FleetClientDeps {
  deploymentMaxMinutes: number;
  /** Startup snapshot of the platform sandbox token; null disables provider I/O. */
  platformToken: string | null;
  /** Per-org custody for legacy rows without a record (cached by the caller/CLI). */
  resolveCustody: (orgId: string) => Promise<Custody>;
}

interface InventoryRow extends PodRow {
  desired_archive_after_minutes: number | null;
  record_revision: number | null;
  record_status: string | null;
  record_credential_source: CredentialSource | null;
}

function hostUrlOf(pod: PodRow): string | null {
  const url = (pod.resolved_config as unknown as {
    config?: { providers?: { sandbox?: { url?: unknown } } };
  })?.config?.providers?.sandbox?.url;
  return typeof url === "string" ? url : null;
}

function requestedOf(pod: PodRow): number {
  const config = (pod.resolved_config as unknown as {
    config?: { archiveAfterMinutes?: unknown; archiveAfterDays?: unknown };
  })?.config;
  if (typeof config?.archiveAfterMinutes === "number") return config.archiveAfterMinutes;
  if (typeof config?.archiveAfterDays === "number") return config.archiveAfterDays * 24 * 60;
  return 60;
}

async function orgMaxFor(orgId: string, cache: Map<string, number | undefined>): Promise<number | undefined> {
  if (cache.has(orgId)) return cache.get(orgId);
  let max: number | undefined;
  try {
    const layer = await readLayer("org_policy", orgId, orgId);
    max = parseStoredPolicy(layer.config ?? {}).policy.maxArchiveAfterMinutes;
  } catch {
    max = undefined;
  }
  cache.set(orgId, max);
  return max;
}

async function readProviderDelay(
  hostUrl: string | null,
  sandboxId: string | null,
  platformToken: string | null,
  client?: SandboxClient | null,
): Promise<number | null> {
  if (!sandboxId || client === null || (!client && (!hostUrl || !platformToken))) return null;
  try {
    const info = await (client ?? new SandboxClient(hostUrl!, platformToken!)).json<{ archiveAfterMinutes?: unknown }>(
      "GET",
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
    );
    return typeof info.archiveAfterMinutes === "number" ? info.archiveAfterMinutes : null;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Dry run: no writes. Set includeProviderReads=false for an offline inventory. */
export async function planRetention(
  deps: ReconcilerDeps & { includeProviderReads?: boolean },
): Promise<RetentionPlan> {
  const rows = await query<InventoryRow>(
    `SELECT p.*,
            r.desired_archive_after_minutes, r.revision AS record_revision, r.status AS record_status,
            r.credential_source AS record_credential_source
       FROM pods p LEFT JOIN pod_retention r ON r.pod_id = p.id
      WHERE p.provider = 'sandbox' AND p.provider_state <> 'gone'
      ORDER BY p.provider_state_changed_at, p.id`,
  );
  const orgCache = new Map<string, number | undefined>();
  const custodyCache = new Map<string, Custody>();
  const entries = await mapWithConcurrency(rows.rows, APPLY_CONCURRENCY, async (pod) => {
    const requested = requestedOf(pod);
    const orgMax = await orgMaxFor(pod.org_id, orgCache);
    // Record first (immutable launch fact), per-org resolver only for legacy rows.
    let custody: Custody = pod.record_credential_source ?? "unknown";
    if (custody === "unknown") {
      const cached = custodyCache.get(pod.org_id);
      if (cached !== undefined) {
        custody = cached;
      } else {
        custody = await deps.resolveCustody(pod.org_id).catch(() => "unknown" as Custody);
        custodyCache.set(pod.org_id, custody);
      }
    }
    const credentialSource = custody === "unknown" ? null : custody;
    const resolved = resolveEffectiveRetention({
      ownedBoxHost: pod.sandbox_host_id ? (await hostForPod(pod))?.owner_user_id != null : false,
      requestedMinutes: requested,
      orgMaxMinutes: orgMax,
      deploymentMaxMinutes: deps.deploymentMaxMinutes,
      providerName: "sandbox",
      credentialSource,
    });
    const effective = resolved.effectiveArchiveAfterMinutes;
    const providerMinutes = deps.includeProviderReads === false || custody !== "platform"
      ? null
      : await readProviderDelay(null, pod.provider_sandbox_id, deps.platformToken, await retentionClient(pod, deps));
    const stoppedAt = pod.provider_state_changed_at;
    const dueAt =
      effective > 0 && pod.provider_state === "stopped" && Number.isFinite(Date.parse(stoppedAt))
        ? new Date(Date.parse(stoppedAt) + effective * 60_000).toISOString()
        : null;
    const overdue = dueAt !== null && Date.parse(dueAt) <= Date.now();
    const hasRecord = pod.desired_archive_after_minutes !== null;
    let action: RetentionAction = "none";
    let detail = "converged";
    if (custody !== "platform") {
      // BYOK/unknown: record custody at most; never touch the provider timer.
      if (!hasRecord || pod.record_credential_source === null) {
        action = "backfill-record";
        detail = `custody ${custody}: backfill record only, provider timer untouched`;
      } else if (pod.desired_archive_after_minutes !== effective) {
        action = "backfill-record";
        detail = `custody ${custody}: record wants ${pod.desired_archive_after_minutes}, policy wants ${effective}; provider timer untouched`;
      } else {
        detail = `custody ${custody}: provider timer out of scope, record converged`;
      }
    } else if (!hasRecord) {
      action = "backfill-record";
      detail = `no pod_retention row; desired ${effective}`;
    } else if (pod.desired_archive_after_minutes !== effective) {
      action = "backfill-record";
      detail = `record wants ${pod.desired_archive_after_minutes}, policy wants ${effective}`;
    } else if (providerMinutes !== null && providerMinutes !== effective) {
      action = "update-retention";
      detail = `provider holds ${providerMinutes}, policy wants ${effective}`;
    }
    if (overdue && pod.provider_state === "stopped") {
      action = action === "none" ? "archive-due" : action;
      detail += "; overdue — the archive sweep releases it sequentially";
    }
    return {
      podId: pod.id,
      orgId: pod.org_id,
      logicalState: pod.state,
      providerState: pod.provider_state,
      hostUrl: hostUrlOf(pod),
      requestedMinutes: requested,
      orgMaxMinutes: orgMax,
      deploymentMaxMinutes: deps.deploymentMaxMinutes,
      scoped: resolved.scoped,
      custody,
      effectiveMinutes: effective,
      providerMinutes,
      stoppedAt,
      dueAt,
      overdue,
      hasRecord,
      recordRevision: pod.record_revision,
      action,
      detail,
    } satisfies RetentionPlanEntry;
  });
  return {
    migrationId: RETENTION_MIGRATION_ID,
    generatedAt: new Date().toISOString(),
    deploymentMaxMinutes: deps.deploymentMaxMinutes,
    entries,
    overdueCount: entries.filter((e) => e.overdue).length,
  };
}

export interface RetentionApplyResult {
  migrationId: string;
  recordsWritten: number;
  providerUpdated: number;
  alreadyConverged: number;
  /** Entries whose fresh re-resolution differed from the plan (plan is a view, not a lock). */
  resolutionsChanged: number;
  /** Unscoped entries recorded but deliberately not converged on the provider. */
  skippedUnscoped: number;
  failed: Array<{ podId: string; reason: string }>;
  overdueCount: number;
}

interface FreshResolution {
  effective: number;
  custody: Custody;
  scoped: boolean;
  orgMax: number | undefined;
  requested: number;
}

/** Re-resolve one pod fresh at apply time: current row, record, org policy, custody. */
async function resolveFresh(
  client: Queryable,
  podId: string,
  deploymentMaxMinutes: number,
  resolveCustody: (orgId: string) => Promise<Custody>,
): Promise<(FreshResolution & { pod: PodRow; record: InventoryRow | null }) | null> {
  const pods = await client.query<PodRow>(`SELECT * FROM pods WHERE id = $1`, [podId]);
  const pod = pods.rows[0] as PodRow | undefined;
  if (!pod || pod.provider !== "sandbox" || pod.provider_state === "gone") return null;
  const recs = await client.query<InventoryRow>(
    `SELECT p.*, r.desired_archive_after_minutes, r.revision AS record_revision,
            r.status AS record_status, r.credential_source AS record_credential_source
       FROM pods p LEFT JOIN pod_retention r ON r.pod_id = p.id WHERE p.id = $1`,
    [podId],
  );
  const record = (recs.rows[0] as InventoryRow | undefined) ?? null;
  let custody: Custody = record?.record_credential_source ?? "unknown";
  if (custody === "unknown") {
    custody = await resolveCustody(pod.org_id).catch(() => "unknown" as Custody);
  }
  let orgMax: number | undefined;
  try {
    const res = await client.query(
      `SELECT config FROM settings WHERE scope_type = 'org_policy' AND scope_id = $1 AND org_id = $1`,
      [pod.org_id],
    );
    const row = res.rows[0] as { config?: unknown } | undefined;
    orgMax = row ? parseStoredPolicy(row.config ?? {}).policy.maxArchiveAfterMinutes : undefined;
  } catch {
    orgMax = undefined;
  }
  const requested = requestedOf(pod);
  const ownedBox = pod.sandbox_host_id ? (await client.query(
    "SELECT 1 FROM sandbox_hosts WHERE id=$1 AND owner_user_id=$2", [pod.sandbox_host_id, pod.user_id],
  )).rowCount !== 0 : false;
  const resolved = resolveEffectiveRetention({
    ownedBoxHost: ownedBox,
    requestedMinutes: requested,
    orgMaxMinutes: orgMax,
    deploymentMaxMinutes,
    providerName: "sandbox",
    credentialSource: custody === "unknown" ? null : custody,
  });
  return {
    pod,
    record,
    effective: resolved.effectiveArchiveAfterMinutes,
    custody,
    scoped: resolved.scoped,
    orgMax,
    requested,
  };
}

/**
 * Persist desired state then converge provider timers. Requires explicit operator approval
 * (the CLI passes approved=true only with --yes). Every entry is re-resolved fresh inside
 * this call — a plan is a dry-run view, never a lock — so a policy change between plan and
 * apply converges to the NEW value and never acks the stale revision. Never archives:
 * overdue pods are left for the sequential sweep, and the result names the wave size.
 */
export async function applyRetentionPlan(
  plan: RetentionPlan,
  args: {
    approved: boolean;
    actorId: string | null;
    deploymentMaxMinutes: number;
    platformToken: string | null;
    kek?: FleetClientDeps["kek"];
    resolveCustody: (orgId: string) => Promise<Custody>;
  },
): Promise<RetentionApplyResult> {
  if (!args.approved) {
    throw new Error("refusing to apply without explicit operator approval (--yes)");
  }
  const result: RetentionApplyResult = {
    migrationId: plan.migrationId,
    recordsWritten: 0,
    providerUpdated: 0,
    alreadyConverged: 0,
    resolutionsChanged: 0,
    skippedUnscoped: 0,
    failed: [],
    overdueCount: plan.overdueCount,
  };
  const todo = plan.entries.filter((e) => e.action === "backfill-record" || e.action === "update-retention");

  // Records first (transactional with audit), provider convergence second — a crash between
  // them leaves status=pending for the status command and a safe retry. Concurrent applies
  // serialize on the row: upsert is ON CONFLICT, and every ack carries a revision guard.
  const writeRecord = async (entry: RetentionPlanEntry): Promise<FreshResolution | null> => {
    let fresh: (FreshResolution & { pod: PodRow; record: InventoryRow | null }) | null = null;
    await tx(async (client) => {
      fresh = await resolveFresh(client, entry.podId, args.deploymentMaxMinutes, args.resolveCustody);
      if (!fresh) return;
      if (fresh.effective !== entry.effectiveMinutes || fresh.custody !== entry.custody) {
        result.resolutionsChanged++;
      }
      const existing = await client.query(
        `SELECT revision, desired_archive_after_minutes, credential_source FROM pod_retention WHERE pod_id = $1`,
        [entry.podId],
      );
      const row = existing.rows[0] as
        | { revision: number; desired_archive_after_minutes: number; credential_source: CredentialSource | null }
        | undefined;
      if (row) {
        const sameDesired = row.desired_archive_after_minutes === fresh.effective;
        const sameCustody = (row.credential_source ?? "unknown") === fresh.custody;
        if (sameDesired && sameCustody) return;
        const updated = await client.query(
          `UPDATE pod_retention SET desired_archive_after_minutes = $2,
             previous_archive_after_minutes = $3, revision = revision + 1,
             credential_source = $4, status = 'pending', last_error = NULL, updated_at = now()
           WHERE pod_id = $1 AND revision = $5 RETURNING revision`,
          [entry.podId, fresh.effective, row.desired_archive_after_minutes, fresh.custody === "unknown" ? null : fresh.custody, row.revision],
        );
        if ((updated.rowCount ?? 0) !== 1) {
          throw new Error("retention revision changed under apply; re-run plan");
        }
      } else {
        await client.query(
          `INSERT INTO pod_retention (pod_id, desired_archive_after_minutes, revision, status, credential_source)
           VALUES ($1, $2, 1, 'pending', $3)
           ON CONFLICT (pod_id) DO NOTHING`,
          [entry.podId, fresh.effective, fresh.custody === "unknown" ? null : fresh.custody],
        );
        // A concurrent apply may have won the insert; converge on the stored revision.
        const reread = await client.query(
          `SELECT revision FROM pod_retention WHERE pod_id = $1`,
          [entry.podId],
        );
        if ((reread.rowCount ?? 0) !== 1) throw new Error("retention record lost under apply; re-run plan");
      }
      await client.query(
        `INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id, detail, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'pod.retention_desired', 'pod', $3, $4, now())`,
        [
          entry.orgId,
          args.actorId,
          entry.podId,
          JSON.stringify({
            migration: plan.migrationId,
            desiredArchiveAfterMinutes: fresh.effective,
            custody: fresh.custody,
          }),
        ],
      );
    });
    if (!fresh) return null;
    result.recordsWritten++;
    return fresh;
  };

  const written = new Map<string, FreshResolution>();
  for (const entry of todo) {
    try {
      const fresh = await writeRecord(entry);
      if (fresh) written.set(entry.podId, fresh);
    } catch (e) {
      result.failed.push({ podId: entry.podId, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // Provider convergence with bounded concurrency. Unscoped rows stop here (recorded, never
  // converged). Equal values are success, not failure. Ambiguous timeouts re-read the
  // provider, and only the revision actually applied is acked (revision-guarded updates).
  const converge = async (entry: RetentionPlanEntry, fresh: FreshResolution): Promise<void> => {
    if (!fresh.scoped) {
      await query(
        `UPDATE pod_retention SET status = 'skipped', last_error = $2, updated_at = now()
         WHERE pod_id = $1`,
        [entry.podId, `custody ${fresh.custody}: provider timer out of scope`],
      ).catch(() => {});
      result.skippedUnscoped++;
      return;
    }
    const podRows = await query<PodRow>(`SELECT * FROM pods WHERE id = $1`, [entry.podId]);
    const pod = podRows.rows[0];
    if (!pod?.provider_sandbox_id) {
      await query(
        `UPDATE pod_retention SET status = 'skipped', last_error = 'no provider sandbox to converge',
           updated_at = now() WHERE pod_id = $1`,
        [entry.podId],
      ).catch(() => {});
      return;
    }
    const client = await retentionClient(pod, args);
    if (!client) return; // Sleeping Boxes are not failures and must never be dialed.
    const rev = await query<{ revision: number }>(
      `SELECT revision FROM pod_retention WHERE pod_id = $1`,
      [entry.podId],
    );
    const expectedRevision = Number(rev.rows[0]?.revision ?? NaN);
    if (!Number.isFinite(expectedRevision)) throw new Error("retention record vanished under apply");
    // Fresh readback FIRST: a plan-time equality is never trusted for convergence.
    const before = await readProviderDelay(null, pod.provider_sandbox_id, args.platformToken, client);
    if (before === fresh.effective) {
      const acked = await query(
        `UPDATE pod_retention SET status = 'applied', provider_archive_after_minutes = $2,
           last_error = NULL, updated_at = now() WHERE pod_id = $1 AND revision = $3`,
        [entry.podId, before, expectedRevision],
      );
      if ((acked.rowCount ?? 0) !== 1) throw new Error("retention revision changed under apply; re-run plan");
      result.alreadyConverged++;
      return;
    }
    try {
      const res = await client.json<{ changed?: unknown }>(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(pod.provider_sandbox_id)}/retention`,
        { archiveAfterMinutes: fresh.effective },
      );
      void res;
    } catch (e) {
      // Ambiguous failure: re-read the provider; only the revision actually applied is acked.
      const current = await readProviderDelay(null, pod.provider_sandbox_id, args.platformToken, client);
      if (current === fresh.effective) {
        const acked = await query(
          `UPDATE pod_retention SET status = 'applied', provider_archive_after_minutes = $2,
             last_error = NULL, updated_at = now() WHERE pod_id = $1 AND revision = $3`,
          [entry.podId, current, expectedRevision],
        );
        if ((acked.rowCount ?? 0) !== 1) throw new Error("retention revision changed under apply; re-run plan");
        result.providerUpdated++;
        return;
      }
      await query(
        `UPDATE pod_retention SET status = 'failed', last_error = $2, updated_at = now()
         WHERE pod_id = $1 AND revision = $3`,
        [entry.podId, (e instanceof Error ? e.message : String(e)).slice(0, 500), expectedRevision],
      );
      throw e;
    }
    // Confirm what the provider actually holds before acking this revision.
    const current = await readProviderDelay(null, pod.provider_sandbox_id, args.platformToken, client);
    if (current === fresh.effective) {
      const acked = await query(
        `UPDATE pod_retention SET status = 'applied', provider_archive_after_minutes = $2,
           last_error = NULL, updated_at = now() WHERE pod_id = $1 AND revision = $3`,
        [entry.podId, current, expectedRevision],
      );
      if ((acked.rowCount ?? 0) !== 1) throw new Error("retention revision changed under apply; re-run plan");
      result.providerUpdated++;
    } else {
      await query(
        `UPDATE pod_retention SET status = 'failed', last_error = 'provider readback diverged',
           updated_at = now() WHERE pod_id = $1 AND revision = $2`,
        [entry.podId, expectedRevision],
      );
      throw new Error(`provider readback ${current} != desired ${fresh.effective}`);
    }
  };
  const outcomes = await mapWithConcurrency(
    [...written.entries()],
    APPLY_CONCURRENCY,
    async ([podId, fresh]) => {
      const entry = todo.find((e) => e.podId === podId)!;
      try {
        await converge(entry, fresh);
        return null;
      } catch (e) {
        return { podId, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  );
  for (const failure of outcomes) {
    if (failure) result.failed.push(failure);
  }
  return result;
}

export interface RetentionStatus {
  migrationId: string;
  totalPods: number;
  withRecord: number;
  applied: number;
  pending: number;
  failed: number;
  skipped: number;
  unscopedRecords: number;
  overdueStopped: number;
  failures: Array<{ podId: string; lastError: string | null; updatedAt: string }>;
}

/** Convergence + overdue wave size. No provider calls; safe to run any time. */
export async function retentionStatus(): Promise<RetentionStatus> {
  const counts = await query<{ status: string | null; n: string }>(
    `SELECT r.status, count(*) AS n FROM pods p
       LEFT JOIN pod_retention r ON r.pod_id = p.id
      WHERE p.provider = 'sandbox' AND p.provider_state <> 'gone'
      GROUP BY r.status`,
  );
  let withRecord = 0;
  let applied = 0;
  let pending = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of counts.rows) {
    const n = Number(row.n);
    if (row.status === null) continue;
    withRecord += n;
    if (row.status === "applied") applied += n;
    else if (row.status === "pending") pending += n;
    else if (row.status === "failed") failed += n;
    else if (row.status === "skipped") skipped += n;
  }
  const total = await query<{ n: string }>(
    `SELECT count(*) AS n FROM pods WHERE provider = 'sandbox' AND provider_state <> 'gone'`,
  );
  const unscoped = await query<{ n: string }>(
    `SELECT count(*) AS n FROM pod_retention WHERE credential_source = 'org-secret' OR credential_source IS NULL`,
  );
  const overdue = await query<{ n: string }>(
    `SELECT count(*) AS n FROM pods p LEFT JOIN pod_retention r ON r.pod_id = p.id
      WHERE p.provider = 'sandbox' AND p.provider_state = 'stopped'
        AND NOT EXISTS (SELECT 1 FROM sandbox_hosts h WHERE h.id=p.sandbox_host_id AND h.owner_user_id IS NOT NULL)
        AND COALESCE(r.desired_archive_after_minutes,
          (p.resolved_config->'retention'->>'effectiveArchiveAfterMinutes')::int,
          (p.resolved_config->'config'->>'archiveAfterMinutes')::int,
          (p.resolved_config->'config'->>'archiveAfterDays')::int * 24 * 60,60) > 0
        AND p.provider_state_changed_at < now() - make_interval(mins => COALESCE(
          r.desired_archive_after_minutes,
          (p.resolved_config->'retention'->>'effectiveArchiveAfterMinutes')::int,
          (p.resolved_config->'config'->>'archiveAfterMinutes')::int,
          (p.resolved_config->'config'->>'archiveAfterDays')::int * 24 * 60, 60))`,
  );
  const failures = await query<{ pod_id: string; last_error: string | null; updated_at: string }>(
    `SELECT pod_id, last_error, updated_at FROM pod_retention WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 50`,
  );
  return {
    migrationId: RETENTION_MIGRATION_ID,
    totalPods: Number(total.rows[0]?.n ?? 0),
    withRecord,
    applied,
    pending,
    failed,
    skipped,
    unscopedRecords: Number(unscoped.rows[0]?.n ?? 0),
    overdueStopped: Number(overdue.rows[0]?.n ?? 0),
    failures: failures.rows.map((r) => ({
      podId: r.pod_id,
      lastError: r.last_error,
      updatedAt: (r.updated_at as unknown as Date)?.toISOString?.() ?? String(r.updated_at),
    })),
  };
}

/** Re-export for CLI wiring convenience. */
export { platformArchiveMaxMinutes };
