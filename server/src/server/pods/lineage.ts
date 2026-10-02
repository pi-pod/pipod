/**
 * Nested pods: a pod token may launch and manage pods, but only inside its own subtree and
 * only within lineage caps that user launches do not have. Provider credentials never travel
 * to the pod — the server provisions the child with its own custody, exactly as for a person.
 */
import type { QueryResult, QueryResultRow } from "pg";
import { conflict, forbidden, notFound } from "../httperrors.js";
import type { OrgPolicy } from "../settings/merge.js";
import { AWAKE_POD_SQL } from "./concurrency.js";

/** Absolute ceiling on nesting, independent of policy: every ancestry walk is bounded by it. */
export const MAX_LINEAGE_DEPTH = 8;

/** Either the pool or a transaction client — lineage checks run in both. */
export interface LineageDb {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/** Per-parent launch rate: a stuck agent loop fails fast instead of provisioning to the cap. */
export const CHILD_LAUNCHES_PER_MINUTE = 10;

export interface NestedPodsPolicy {
  enabled: boolean;
  maxDepth: number;
  maxChildrenPerPod: number;
  maxPodsPerLineage: number;
  allowFileSend: boolean;
  allowFileReceive: boolean;
}

export interface PlanChildLineageOptions {
  /**
   * Co-located children are exempt from the count caps (they cost no extra machine), but
   * never from the launch rate limit or the absolute depth ceiling — a looping spawner must
   * fail fast instead of fork-bombing the host. Their rows are also invisible to the counts
   * themselves, so a tree of co-located pods never crowds out a sibling that needs a machine.
   */
  colocated?: boolean;
}

export const NESTED_PODS_DEFAULTS: NestedPodsPolicy = {
  enabled: true,
  maxDepth: 2,
  maxChildrenPerPod: 5,
  maxPodsPerLineage: 10,
  allowFileSend: true,
  allowFileReceive: true,
};

export function nestedPodsPolicy(policy: OrgPolicy): NestedPodsPolicy {
  return { ...NESTED_PODS_DEFAULTS, ...policy.nestedPods };
}

export interface LineagePlacement {
  parentPodId: string;
  lineageRootId: string;
  lineageDepth: number;
}

/**
 * Resolve a child's place in the tree and refuse it if any lineage cap is already met.
 * Called twice per launch: once early for a cheap failure, once inside the insert transaction
 * (with the lineage root row locked) so two concurrent child launches cannot both pass.
 */
export async function planChildLineage(
  db: LineageDb,
  args: { orgId: string; parentPodId: string; policy: NestedPodsPolicy },
  options: PlanChildLineageOptions = {},
): Promise<LineagePlacement> {
  if (!args.policy.enabled) {
    throw forbidden("org policy nestedPods.enabled is false: pods may not launch pods");
  }
  const parents = await db.query<{ id: string; lineage_root_id: string | null; lineage_depth: number }>(
    "SELECT id, lineage_root_id, lineage_depth FROM pods WHERE id = $1 AND org_id = $2",
    [args.parentPodId, args.orgId],
  );
  const parent = parents.rows[0];
  if (!parent) throw notFound("the launching pod no longer exists");

  const lineageDepth = parent.lineage_depth + 1;
  const depthCeiling = options.colocated ? MAX_LINEAGE_DEPTH : Math.min(args.policy.maxDepth, MAX_LINEAGE_DEPTH);
  if (lineageDepth > depthCeiling) {
    throw conflict(
      options.colocated
        ? `nesting is capped at ${MAX_LINEAGE_DEPTH} levels`
        : `org policy nestedPods.maxDepth caps nesting at ${args.policy.maxDepth}`,
    );
  }
  const lineageRootId = parent.lineage_root_id ?? parent.id;

  // The count caps price awake sandboxes, so a subtree that has put its pods to sleep can
  // grow again; the rate limit below is what still bounds a supervisor that only creates rows.
  const counted = await db.query<{ children: string; lineage: string; recent: string }>(
    `SELECT
       count(*) FILTER (WHERE parent_pod_id = $1 AND ${AWAKE_POD_SQL}) AS children,
       count(*) FILTER (WHERE ${AWAKE_POD_SQL}) AS lineage,
       count(*) FILTER (WHERE parent_pod_id = $1 AND created_at > now() - interval '1 minute') AS recent
     FROM pods WHERE lineage_root_id = $2`,
    [parent.id, lineageRootId],
  );
  const counts = counted.rows[0]!;
  if (Number(counts.recent) >= CHILD_LAUNCHES_PER_MINUTE) {
    throw conflict(`this pod has launched ${CHILD_LAUNCHES_PER_MINUTE} pods in the last minute`);
  }
  if (!options.colocated) {
    if (Number(counts.children) >= args.policy.maxChildrenPerPod) {
      throw conflict(`org policy nestedPods.maxChildrenPerPod caps awake children at ${args.policy.maxChildrenPerPod}`);
    }
    if (Number(counts.lineage) >= args.policy.maxPodsPerLineage) {
      throw conflict(`org policy nestedPods.maxPodsPerLineage caps awake pods per lineage at ${args.policy.maxPodsPerLineage}`);
    }
  }
  return { parentPodId: parent.id, lineageRootId, lineageDepth };
}

/**
 * Serializes concurrent child launches within one lineage: every cap check in a tree waits on
 * the same root row, so two supervisors cannot both read a count that leaves room for one pod.
 */
export async function lockLineageRoot(db: LineageDb, args: { orgId: string; parentPodId: string }): Promise<void> {
  await db.query(
    `SELECT root.id FROM pods child
       JOIN pods root ON root.id = COALESCE(child.lineage_root_id, child.id)
      WHERE child.id = $1 AND child.org_id = $2
      FOR UPDATE OF root`,
    [args.parentPodId, args.orgId],
  );
}

/**
 * The reach of a pod token: the pods it launched, transitively. The walk is bounded by the
 * absolute depth ceiling, so it costs O(depth) rather than O(tree) even on bad data.
 */
export async function isDescendantOf(
  db: LineageDb,
  args: { orgId: string; podId: string; ancestorPodId: string },
): Promise<boolean> {
  if (args.podId === args.ancestorPodId) return false;
  const found = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_pod_id, 0 AS steps FROM pods WHERE id = $1 AND org_id = $2
       UNION ALL
       SELECT p.id, p.parent_pod_id, chain.steps + 1 FROM pods p
         JOIN chain ON p.id = chain.parent_pod_id
        WHERE chain.steps < $4
     )
     SELECT 1 FROM chain WHERE id = $3 LIMIT 1`,
    [args.podId, args.orgId, args.ancestorPodId, MAX_LINEAGE_DEPTH],
  );
  return (found.rowCount ?? 0) > 0;
}

/**
 * Every pod in a subtree, deepest first — the order a cascade delete must use. The tree
 * follows both edges: launched-by (parent_pod_id) and hosted-on (host_pod_id), so deleting
 * a host takes down pods a user placed on its machine, not only pods it launched.
 */
export async function subtreeDeepestFirst(
  db: LineageDb,
  args: { orgId: string; podId: string; includeSelf: boolean },
): Promise<Array<{ id: string; lineage_depth: number }>> {
  const rows = await db.query<{ id: string; lineage_depth: number }>(
    `WITH RECURSIVE subtree AS (
       SELECT id, parent_pod_id, lineage_depth, 0 AS steps FROM pods WHERE id = $1 AND org_id = $2
       UNION ALL
       SELECT p.id, p.parent_pod_id, p.lineage_depth, subtree.steps + 1 FROM pods p
         JOIN subtree ON p.parent_pod_id = subtree.id OR p.host_pod_id = subtree.id
        WHERE subtree.steps < $3
     )
     SELECT id, lineage_depth FROM subtree ORDER BY steps DESC`,
    [args.podId, args.orgId, MAX_LINEAGE_DEPTH],
  );
  const seen = new Set<string>();
  const deduped = rows.rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
  return args.includeSelf ? deduped : deduped.filter((row) => row.id !== args.podId);
}

/** Children that still cost something: a delete refuses to orphan these without --cascade.
 *  Includes pods hosted on this one's machine — deleting the machine deletes their substrate. */
export async function liveChildren(
  db: LineageDb,
  args: { orgId: string; podId: string },
): Promise<Array<{ id: string; name: string; state: string }>> {
  const rows = await db.query<{ id: string; name: string; state: string }>(
    `SELECT DISTINCT ON (id) id, name, state FROM pods
      WHERE (parent_pod_id = $1 OR host_pod_id = $1) AND org_id = $2
        AND state <> 'archived' AND provider_state <> 'gone'
      ORDER BY id, created_at`,
    [args.podId, args.orgId],
  );
  return rows.rows;
}

/**
 * Lift a deleted pod's children onto its own parent so no live pod hangs off a gone one.
 * Each child's whole subtree shifts up one level; a child promoted to the top of the tree
 * becomes its own lineage root. Postgres evaluates the CTE against the pre-update snapshot,
 * so reading the old shape and writing the new one in one statement is safe.
 */
export async function reparentChildren(
  db: LineageDb,
  args: { orgId: string; podId: string; grandparentPodId: string | null },
): Promise<number> {
  const children = await db.query<{ id: string }>(
    "SELECT id FROM pods WHERE parent_pod_id = $1 AND org_id = $2",
    [args.podId, args.orgId],
  );
  for (const child of children.rows) {
    await db.query(
      `WITH RECURSIVE subtree AS (
         SELECT id, parent_pod_id, 0 AS steps FROM pods WHERE id = $1
         UNION ALL
         SELECT p.id, p.parent_pod_id, subtree.steps + 1 FROM pods p
           JOIN subtree ON p.parent_pod_id = subtree.id
          WHERE subtree.steps < $3
       )
       UPDATE pods SET
         parent_pod_id = CASE WHEN id = $1 THEN $2::uuid ELSE parent_pod_id END,
         lineage_root_id = CASE WHEN $2::uuid IS NULL THEN $1::uuid ELSE lineage_root_id END,
         lineage_depth = GREATEST(lineage_depth - 1, 0),
         updated_at = now()
       WHERE id IN (SELECT id FROM subtree)`,
      [child.id, args.grandparentPodId, MAX_LINEAGE_DEPTH],
    );
  }
  return children.rows.length;
}

/** A pod token reaches only what it launched; everything else answers 403, never 404. */
export async function assertPodTokenReach(
  db: LineageDb,
  args: { orgId: string; callerPodId: string; podId: string; action: string; allowSelf?: boolean },
): Promise<void> {
  if (args.allowSelf && args.podId === args.callerPodId) return;
  if (await isDescendantOf(db, { orgId: args.orgId, podId: args.podId, ancestorPodId: args.callerPodId })) return;
  throw forbidden(
    args.podId === args.callerPodId
      ? `a pod cannot ${args.action} itself`
      : `a pod token may only ${args.action} pods it launched`,
  );
}

/**
 * What a pod-requested launch may carry: no more than its parent pod was given. The parent
 * holds its owner's bundle and model credentials as of its own launch; its child must not
 * reach a layer the parent lacked (an org job runs without the owner's bundle) or a model
 * provider outside the parent's credential contract. A parent that predates contracts
 * delegates no providers.
 */
export interface ParentDelegation {
  parentPodId: string;
  includeUserBundle: boolean;
  credentialProviders: ReadonlySet<string>;
}

export async function parentDelegation(
  db: LineageDb,
  args: { orgId: string; parentPodId: string },
): Promise<ParentDelegation> {
  const rows = await db.query<{ layer_order: unknown; credential_providers: string[] | null }>(
    `SELECT resolved_config->'layerOrder' AS layer_order, credential_providers
       FROM pods WHERE id = $1 AND org_id = $2`,
    [args.parentPodId, args.orgId],
  );
  const parent = rows.rows[0];
  if (!parent) throw notFound("parent pod not found");
  return {
    parentPodId: args.parentPodId,
    includeUserBundle: !Array.isArray(parent.layer_order) || parent.layer_order.includes("user"),
    credentialProviders: new Set(parent.credential_providers ?? []),
  };
}

/**
 * A parent launched without its owner's bundle has none of the owner's personal templates
 * either (their scripts and template secrets), except the ones it wrote itself.
 */
export function delegatesTemplate(
  template: { owner_user_id: string | null; created_from_pod: string | null },
  delegation: ParentDelegation | null | undefined,
): boolean {
  return !delegation || delegation.includeUserBundle || template.owner_user_id === null ||
    template.created_from_pod === delegation.parentPodId;
}

export function assertDelegatedTemplate(
  template: { owner_user_id: string | null; created_from_pod: string | null },
  delegation: ParentDelegation | null | undefined,
): void {
  if (!delegatesTemplate(template, delegation)) {
    throw forbidden("this pod runs without its owner's settings and cannot use their personal templates");
  }
}

/** Narrows a planned launch's model credentials to what its parent may delegate. */
export function delegateCredentials(
  planned: { piAuth: { providers: string[] } | null; credentialContract: string[] },
  delegation: ParentDelegation,
): { piAuth: { providers: string[] } | null; credentialContract: string[] } {
  const allowed = (id: string) => delegation.credentialProviders.has(id);
  const providers = planned.piAuth?.providers.filter(allowed) ?? [];
  return {
    piAuth: providers.length > 0 ? { providers } : null,
    credentialContract: planned.credentialContract.filter(allowed),
  };
}
