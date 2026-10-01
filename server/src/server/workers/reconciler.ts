import { MANAGED_BY_KEY, MANAGED_BY_VALUE } from "../../core/labels.js";
import type { PodRow } from "../pods/types.js";
import { hostForPod, hostCanDial } from "../pods/hostidentity.js";
import { query } from "../db/index.js";
import { cascadeHostChildrenRows } from "../pods/lifecycle.js";
import { platformCredentialsOf, withProviderCredential } from "../pods/providercred.js";
import { enqueuePush } from "../push/queue.js";
import { edition } from "../edition.js";
import type { WorkerDeps } from "./index.js";

/**
 * Postgres rows are a cache/index of provider reality (spec §3, §12): list sandboxes per
 * (org, provider, provider config), converge state and last-activity, and flag rows the selected
 * endpoint no longer knows. Config is part of the key so explicit sandbox service overrides
 * cannot reconcile against the deployment-default endpoint.
 *
 * Ordering and CAS discipline (retirement hardening):
 *  - The group's ROWS are captured BEFORE the provider list. A row that is re-pointed into this
 *    group (guarded rehome commits the PG pointer after the target import) between the two reads
 *    is therefore never judged against a list captured before its import — with the opposite
 *    order, a freshly adopted row could be marked `gone` by a stale target list.
 *  - Every mutative UPDATE re-asserts the FULL captured tuple — id, org, provider, sandbox id,
 *    provider state and provider config — not just id + provider state. A row whose pointer or
 *    sandbox id was rebound after capture (repoint, SID rebind, stale source route) no longer
 *    matches and is left alone for the next tick, which re-reads it in its new group.
 *  - Cascade/push are gated on the row actually updated (RETURNING), never on intent.
 *  - No no-op writes: a row whose provider state, activity high-water mark and stop cause would
 *    all be unchanged is not touched, so `updated_at` stays a meaningful change marker.
 * Source quiescence for moves remains procedure-gated (native holds); nothing here claims
 * distributed atomicity across the provider list and the database.
 */
/** Provider reconciliation follows provider reality without erasing a terminal launch failure. */
export function reconciledPodState(_provider: string, currentState: string, providerState: string): string {
  // A provider may independently idle-stop the sandbox retained for diagnosis. That must not
  // make a failed init look like a healthy stopped session that the user can resume.
  if (currentState === "error") return "error";
  return providerState;
}

const PROVIDER_TRANSITIONS = new Set(["preparing_image", "provisioning", "starting", "stopping", "archiving", "deleting"]);
const TRANSITION_GRACE_MS = 15 * 60 * 1000;

/** Exact state_reason the gone UPDATE writes. Restore may revive a gone row
 * only when it still carries this reason (reconciler race), never a user
 * deletion or other tombstone. */
export const RECONCILER_GONE_REASON = "the provider no longer knows this sandbox";


export function isFreshProviderTransition(
  state: string,
  changedAt: string | Date,
  nowMs: number = Date.now(),
): boolean {
  return PROVIDER_TRANSITIONS.has(state) && nowMs - new Date(changedAt).getTime() < TRANSITION_GRACE_MS;
}

/** Exact captured tuple every mutative UPDATE must still match (stale-route protection). */
const CAPTURED_TUPLE_PREDICATE = `id = $1 AND provider_state = $2 AND org_id = $3 AND provider = $4
           AND provider_sandbox_id = $5
           AND sandbox_host_id IS NOT DISTINCT FROM $9::text
           AND ($11::text IS NULL OR EXISTS (SELECT 1 FROM sandbox_hosts h WHERE h.id = $11 AND h.generation = $10::bigint AND (h.box_state IS NULL OR h.box_state = 'running') FOR SHARE))
           AND COALESCE(resolved_config #> ARRAY['config', 'providers', provider], '{}'::jsonb) = $6::jsonb`;

export async function runReconciler(deps: WorkerDeps): Promise<void> {
  const groups = await query<{
    org_id: string;
    provider: string;
    sandbox_host_id: string | null;
    provider_config: Record<string, unknown>;
  }>(
    `SELECT DISTINCT org_id, provider, sandbox_host_id,
       COALESCE(resolved_config #> ARRAY['config', 'providers', provider], '{}'::jsonb) AS provider_config
     FROM pods
     WHERE provider_state NOT IN ('gone') AND provider_sandbox_id IS NOT NULL
       AND provider <> 'host'`,
  );

  for (const group of groups.rows) {
    const providerConfigJson = JSON.stringify(group.provider_config);
    // Rows FIRST (see module header): the membership judged below is the membership that
    // existed before the list was taken, never one that grew while the list was in flight.
    const rows = await query<PodRow>(
      `SELECT * FROM pods
       WHERE org_id = $1 AND provider = $2 AND provider_sandbox_id IS NOT NULL
         AND provider_state NOT IN ('gone')
         AND COALESCE(resolved_config #> ARRAY['config', 'providers', provider], '{}'::jsonb) = $3::jsonb
         AND sandbox_host_id IS NOT DISTINCT FROM $4::text`,
      [group.org_id, group.provider, providerConfigJson, group.sandbox_host_id],
    );
    if (rows.rows.length === 0) continue;

    // Reconciliation must route the CAPTURED group, not a freshly repointed
    // representative pod: otherwise its new endpoint could condemn the other
    // members still on the old host. Omit id to opt out of pod refresh.
    const { id: representativeId, ...capturedIdentity } = rows.rows[0]!;
    // Preserve the pod's immutable custody ID without requesting a fresh route.
    const capturedPod = { ...capturedIdentity, custody_pod_id: representativeId };
    let infos;
    let host;
    try {
      host = await hostForPod(capturedPod);
      if (host && !hostCanDial(host)) continue;
      infos = await withProviderCredential({
        pod: capturedPod,
        kek: deps.kek,
        platformEnv: platformCredentialsOf(deps),
        orgId: group.org_id,
        provider: group.provider,
        providerConfig: group.provider_config,
        // Membership is provider_sandbox_id below; the org label is stamped at creation, so a
        // remapped org id would leave every live sandbox unmatched and reap the org.
        fn: (provider) => provider.list({ [MANAGED_BY_KEY]: MANAGED_BY_VALUE }),
      });
    } catch (e) {
      deps.log.warn(`reconciler: cannot list ${group.provider} for org ${group.org_id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const byId = new Map(infos.map((info) => [info.id, info]));

    for (const row of rows.rows) {
      const info = byId.get(row.provider_sandbox_id!);
      // A provider list naturally reports the pre-operation state while stop/start/archive is
      // in flight. Preserve the CAS barrier until the command completes or the grace expires.
      if (isFreshProviderTransition(row.provider_state, row.provider_state_changed_at)) continue;
      const tuple = [row.id, row.provider_state, group.org_id, group.provider, row.provider_sandbox_id, providerConfigJson];
      if (!info) {
        // After the transition grace, a missing provider object is recovery evidence for a
        // process that died mid-transition — but only for the exact row captured above. A row
        // re-pointed or re-bound since capture fails the tuple predicate and is left for the
        // next tick, which reads it in its new group against that group's own list.
        // An edition moving this sandbox to a NEW host while the row still names the
        // OLD one must not see it marked gone before the atomic repoint.
        const goneGuard = edition().reconcileGoneGuardSql ? `AND ${edition().reconcileGoneGuardSql}` : "";
        const gone = await query(
          `UPDATE pods SET provider_state = 'gone', provider_state_changed_at = now(),
             state_reason = $12, reaped_at = now(), updated_at = now()
           WHERE ${CAPTURED_TUPLE_PREDICATE} AND $7::text IS NULL AND $8::text IS NULL
             ${goneGuard}
           RETURNING id`,
          [...tuple, null, null, group.sandbox_host_id, host?.generation ?? null, host?.id ?? null,
            RECONCILER_GONE_REASON],
        );
        if ((gone.rowCount ?? 0) === 0) continue;
        if (deps.gateway) await deps.gateway.closePod(row.id, "gone");
        const orphaned = await cascadeHostChildrenRows(row.id, "gone").catch(() => []);
        if (deps.gateway) {
          for (const childId of orphaned) await deps.gateway.closePod(childId, "host_stopped");
        }
        // A pod vanishing out from under its owner deserves a push, not a silent list entry.
        const redacted = row.resolved_config?.notificationsRedacted ?? false;
        await enqueuePush(row.user_id, {
          title: redacted ? "a pod is gone" : `pod gone: ${row.name}`,
          body: redacted
            ? ""
            : "the provider no longer knows this sandbox — it may have been deleted outside pi pod",
          data: { pod_id: row.id, org_id: group.org_id, kind: "pod_error" },
        }).catch(() => {});
        continue;
      }
      const nextState = reconciledPodState(group.provider, row.provider_state, info.state);
      // Write only when something observable changes: the provider state, the activity
      // high-water mark (a strictly newer provider timestamp), or a stop cause that is still
      // unset for a stopped/archived state. An identical observation is a no-op and must not
      // touch updated_at.
      const updated = await query(
        `UPDATE pods SET provider_state = $7,
           last_stop_cause = CASE
             WHEN last_stop_cause IS NOT NULL THEN last_stop_cause
             WHEN $7 IN ('stopped', 'stopping') THEN 'provider_stopped'
             WHEN $7 IN ('archived', 'archiving') THEN 'provider_archived'
             ELSE last_stop_cause
           END,
           provider_state_changed_at = CASE WHEN provider_state <> $7 THEN now() ELSE provider_state_changed_at END,
           last_activity_at = CASE WHEN $8::timestamptz IS NULL THEN last_activity_at
             ELSE GREATEST(COALESCE(last_activity_at, '-infinity'::timestamptz), $8::timestamptz) END,
           updated_at = now()
         WHERE ${CAPTURED_TUPLE_PREDICATE}
           AND (
             provider_state <> $7
             OR ($8::timestamptz IS NOT NULL AND $8::timestamptz > COALESCE(last_activity_at, '-infinity'::timestamptz))
             OR (last_stop_cause IS NULL AND $7 IN ('stopped', 'stopping', 'archived', 'archiving'))
           )
         RETURNING id`,
        [...tuple, nextState, info.lastActivityAt ?? null, group.sandbox_host_id, host?.generation ?? null, host?.id ?? null],
      );
      if (
        (updated.rowCount ?? 0) > 0 &&
        row.provider_state === "started" &&
        nextState !== "started"
      ) {
        if (deps.gateway) await deps.gateway.closePod(row.id, `provider_${nextState}`);
        // The provider took a host's machine down outside pi pod; its co-located children's
        // processes went with it.
        if (nextState === "stopped" || nextState === "archived" || nextState === "gone") {
          const children = await cascadeHostChildrenRows(row.id, nextState).catch(() => []);
          if (deps.gateway) {
            for (const childId of children) await deps.gateway.closePod(childId, "host_stopped");
          }
        }
      }
    }
  }
}
