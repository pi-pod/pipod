import { MAX_LINEAGE_DEPTH } from "./lineage.js";
import { query } from "../db/index.js";
import { notFound } from "../httperrors.js";
import type { PodRow } from "./types.js";

export async function setProviderState(podId: string, state: string, reason?: string): Promise<void> {
  await query("UPDATE pods SET provider_state = $2, provider_state_changed_at = now(), state_reason = $3, updated_at = now() WHERE id = $1", [
    podId,
    state,
    reason ?? null,
  ]);
}

export async function getPod(orgId: string, podId: string): Promise<PodRow> {
  const rows = await query<PodRow>(
    `SELECT p.*, h.name AS host_pod_name FROM pods p
       LEFT JOIN pods h ON h.id = p.host_pod_id
      WHERE p.id = $1 AND p.org_id = $2`,
    [podId, orgId],
  );
  const row = rows.rows[0];
  if (!row) throw notFound("pod not found");
  return row;
}

/** Every way `GET /v1/pods` narrows the org's pods; an omitted filter never narrows anything. */
export interface PodListFilters {
  orgId: string;
  state?: "active" | "archived" | null;
  /** One person's pods (the CLI's `mine`); null is the whole org. */
  userId?: string | null;
  /** Legacy timestamp-only boundary; new clients use the server-issued cursor. */
  before?: string | null;
  /** Exact database activity timestamp and UUID, ordered together newest-first. */
  cursor?: { activityAt: string; id: string } | null;
  limit: number;
  project?: string | null;
  /** Pods launched from one template — the environment's own roster. */
  templateId?: string | null;
  /** A pod token's own subtree: this pod and its descendants. */
  lineageRootPodId?: string | null;
  /** Include provider_state 'gone' rows (default false: listings omit them). */
  includeGone?: boolean | null;
}

/**
 * The pod listing, newest activity first. Kept here rather than inline in the route so the
 * filters are testable against a real database — every one of them is a WHERE clause whose
 * null case has to keep meaning "everything".
 */
export async function listPods(filters: PodListFilters): Promise<Array<PodRow & { list_activity_at: string }>> {
  const rows = await query<PodRow & { list_activity_at: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT id, 0 AS steps FROM pods WHERE id = $7::uuid AND org_id = $1
       UNION ALL
       SELECT p.id, subtree.steps + 1 FROM pods p
         JOIN subtree ON p.parent_pod_id = subtree.id OR p.host_pod_id = subtree.id
        WHERE subtree.steps < $8
     )
     SELECT p.*, h.name AS host_pod_name,
       -- Keep microseconds out of pg's JavaScript Date conversion for the next-page cursor.
       to_char(COALESCE(p.last_activity_at, p.created_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS list_activity_at
       FROM pods p LEFT JOIN pods h ON h.id = p.host_pod_id
     WHERE p.org_id = $1
       AND ($10::boolean IS TRUE OR p.provider_state <> 'gone')
       AND ($2::text IS NULL OR p.state = $2)
       AND ($3::text IS NULL OR p.user_id = $3)
       AND ($4::timestamptz IS NULL OR COALESCE(p.last_activity_at, p.created_at) < $4)
       AND ($11::timestamptz IS NULL OR (COALESCE(p.last_activity_at, p.created_at), p.id) < ($11, $12::uuid))
       AND ($6::text IS NULL OR p.project = $6)
       AND ($7::uuid IS NULL OR p.id IN (SELECT DISTINCT id FROM subtree))
       AND ($9::uuid IS NULL OR p.template_id = $9)
     ORDER BY COALESCE(p.last_activity_at, p.created_at) DESC, p.id DESC LIMIT $5`,
    [
      filters.orgId,
      filters.state ?? null,
      filters.userId ?? null,
      filters.before ?? null,
      filters.limit,
      filters.project ?? null,
      filters.lineageRootPodId ?? null,
      MAX_LINEAGE_DEPTH,
      filters.templateId ?? null,
      filters.includeGone ?? false,
      filters.cursor?.activityAt ?? null,
      filters.cursor?.id ?? null,
    ],
  );
  return rows.rows;
}
