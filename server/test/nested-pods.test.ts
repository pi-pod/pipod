/**
 * Nested pods (docs/nested-pods-plan.md): lineage placement, the caps that bound a runaway
 * supervisor, and the reach of a pod token.
 *
 * The suite that needs Postgres is skipped unless PI_POD_TEST_DATABASE_URL points at a
 * migrated database — the tree rules are SQL, and reimplementing them in a fake would test
 * the fake. Run them with:
 *   PI_POD_TEST_DATABASE_URL=postgres://pipod:pipod@localhost:5432/pipod npm run test:integration
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query, tx } from "../src/server/db/index.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  CHILD_LAUNCHES_PER_MINUTE,
  assertPodTokenReach,
  isDescendantOf,
  liveChildren,
  lockLineageRoot,
  nestedPodsPolicy,
  planChildLineage,
  reparentChildren,
  subtreeDeepestFirst,
  NESTED_PODS_DEFAULTS,
} from "../src/server/pods/lineage.js";
import { PolicySchema } from "../src/server/settings/merge.js";

describe("nested pod policy", () => {
  it("defaults to shallow nesting with room to fan out", () => {
    assert.deepEqual(nestedPodsPolicy({}), {
      enabled: true,
      maxDepth: 2,
      maxChildrenPerPod: 5,
      maxPodsPerLineage: 10,
      allowFileSend: true,
      allowFileReceive: true,
    });
  });

  it("takes each configured key without losing the others", () => {
    assert.deepEqual(nestedPodsPolicy({ nestedPods: { maxDepth: 4 } }), {
      ...NESTED_PODS_DEFAULTS,
      maxDepth: 4,
    });
    assert.equal(nestedPodsPolicy({ nestedPods: { enabled: false } }).enabled, false);
  });

  it("validates the policy surface: unknown keys and out-of-range ceilings are refused", () => {
    assert.equal(PolicySchema.safeParse({ nestedPods: { maxDepth: 2 } }).success, true);
    assert.equal(PolicySchema.safeParse({ nestedPods: { enabled: false } }).success, true);
    assert.equal(PolicySchema.safeParse({ nestedPods: { allowFileReceive: true } }).success, true);
    assert.equal(PolicySchema.safeParse({ nestedPods: { allowFileReceive: false } }).success, true);
    assert.equal(PolicySchema.safeParse({ nestedPods: { maxDepth: 99 } }).success, false);
    assert.equal(PolicySchema.safeParse({ nestedPods: { maxPodsPerLineage: 0 } }).success, false);
    assert.equal(PolicySchema.safeParse({ nestedPods: { unlimited: true } }).success, false);
  });
});

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("nested pod lineage (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const policy = nestedPodsPolicy({});

  /** A pod row with only the columns lineage rules read. */
  async function makePod(
    args: { parent?: Pod | null; state?: string; providerState?: string; provider?: string } = {},
  ): Promise<Pod> {
    const id = uuidv7();
    const parent = args.parent ?? null;
    await query(
      `INSERT INTO pods (id, org_id, template_id, user_id, name, provider, state, provider_state,
                         resolved_config, parent_pod_id, lineage_root_id, lineage_depth)
       VALUES ($1, $2, NULL, $3, 'pod', $9, $4, $5, '{}'::jsonb, $6, COALESCE($7::uuid, $1::uuid), $8)`,
      [
        id,
        orgId,
        userId,
        args.state ?? "active",
        args.providerState ?? "started",
        parent?.id ?? null,
        parent ? parent.lineageRootId : null,
        parent ? parent.depth + 1 : 0,
        args.provider ?? "sandbox",
      ],
    );
    return { id, lineageRootId: parent ? parent.lineageRootId : id, depth: parent ? parent.depth + 1 : 0 };
  }

  interface Pod {
    id: string;
    lineageRootId: string;
    depth: number;
  }

  async function refused(fn: () => Promise<unknown>): Promise<HttpError> {
    try {
      await fn();
    } catch (e) {
      assert.ok(e instanceof HttpError, `expected an HttpError, got ${String(e)}`);
      return e;
    }
    throw new Error("expected the call to be refused");
  }

  before(async () => {
    initPool(databaseUrl!);
    await query(
      "INSERT INTO organizations (id, name) VALUES ($1, 'nested test org')",
      [orgId],
    );
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@example.test`,
    ]);
  });

  after(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("UPDATE pods SET parent_pod_id = NULL WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    await query("UPDATE pods SET parent_pod_id = NULL WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
  });

  it("places a child under its parent and keeps the lineage root of the tree", async () => {
    const root = await makePod();
    const placement = await planChildLineage({ query }, { orgId, parentPodId: root.id, policy });
    assert.deepEqual(placement, { parentPodId: root.id, lineageRootId: root.id, lineageDepth: 1 });

    const child = await makePod({ parent: root });
    const grandchild = await planChildLineage({ query }, { orgId, parentPodId: child.id, policy });
    assert.deepEqual(grandchild, { parentPodId: child.id, lineageRootId: root.id, lineageDepth: 2 });
  });

  it("refuses a launch past maxDepth", async () => {
    const root = await makePod();
    const child = await makePod({ parent: root });
    const grandchild = await makePod({ parent: child });
    const error = await refused(() => planChildLineage({ query }, { orgId, parentPodId: grandchild.id, policy }));
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /maxDepth/);
  });

  it("counts only pods awake at the provider against the fan-out and lineage caps", async () => {
    const root = await makePod();
    const children: Pod[] = [];
    for (let i = 0; i < NESTED_PODS_DEFAULTS.maxChildrenPerPod; i += 1) {
      children.push(await makePod({ parent: root }));
    }
    const capped = await refused(() => planChildLineage({ query }, { orgId, parentPodId: root.id, policy }));
    assert.equal(capped.statusCode, 409);
    assert.match(capped.message, /maxChildrenPerPod caps awake children/);

    // Hiding a pod from the active lists does not release its sandbox, so it keeps its slot.
    await query("UPDATE pods SET state = 'archived' WHERE parent_pod_id = $1", [root.id]);
    await refused(() => planChildLineage({ query }, { orgId, parentPodId: root.id, policy }));

    // Sleeping does release it: caps price what is running, not what exists.
    await query("UPDATE pods SET provider_state = 'stopped' WHERE id = $1", [children[0]!.id]);
    const placement = await planChildLineage({ query }, { orgId, parentPodId: root.id, policy });
    assert.equal(placement.lineageDepth, 1);
  });

  it("never counts co-located children, which hold no machine of their own", async () => {
    const root = await makePod();
    for (let i = 0; i < NESTED_PODS_DEFAULTS.maxChildrenPerPod; i += 1) {
      await makePod({ parent: root, provider: "host" });
    }
    const placement = await planChildLineage({ query }, { orgId, parentPodId: root.id, policy });
    assert.equal(placement.parentPodId, root.id);
  });

  it("caps the whole lineage, not just one parent's children", async () => {
    const root = await makePod();
    const sibling = await makePod({ parent: root });
    for (let i = 0; i < 3; i += 1) await makePod({ parent: root });
    const leaf = await makePod({ parent: root });
    for (let i = 0; i < 4; i += 1) await makePod({ parent: leaf });
    // 1 root + 5 children + 4 grandchildren = 10 awake pods, the default lineage cap. The leaf
    // is well under its own fan-out cap, so only the lineage total can refuse this.
    const deep = { ...policy, maxDepth: 4 };
    const error = await refused(() => planChildLineage({ query }, { orgId, parentPodId: leaf.id, policy: deep }));
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /maxPodsPerLineage caps awake pods per lineage/);

    // Any member going to sleep gives the whole lineage its slot back, wherever it sits.
    await query("UPDATE pods SET provider_state = 'stopped' WHERE id = $1", [sibling.id]);
    const placement = await planChildLineage({ query }, { orgId, parentPodId: leaf.id, policy: deep });
    assert.equal(placement.lineageRootId, root.id);
  });

  it("is a hard 403 when the organization disables nesting", async () => {
    const root = await makePod();
    const error = await refused(() =>
      planChildLineage({ query }, { orgId, parentPodId: root.id, policy: { ...policy, enabled: false } }),
    );
    assert.equal(error.statusCode, 403);
  });

  it("rate limits a stuck agent loop before it provisions to the cap", async () => {
    const root = await makePod();
    const generous = { ...policy, maxChildrenPerPod: 100, maxPodsPerLineage: 500 };
    for (let i = 0; i < CHILD_LAUNCHES_PER_MINUTE; i += 1) await makePod({ parent: root });
    const error = await refused(() => planChildLineage({ query }, { orgId, parentPodId: root.id, policy: generous }));
    assert.match(error.message, /in the last minute/);

    await query("UPDATE pods SET created_at = now() - interval '2 minutes' WHERE parent_pod_id = $1", [root.id]);
    const placement = await planChildLineage({ query }, { orgId, parentPodId: root.id, policy: generous });
    assert.equal(placement.parentPodId, root.id);
  });

  it("serializes concurrent child launches so two cannot pass the same last slot", async () => {
    const root = await makePod();
    const tight = { ...policy, maxChildrenPerPod: 1 };
    const attempt = async (): Promise<string | null> =>
      tx(async (client) => {
        await lockLineageRoot(client, { orgId, parentPodId: root.id });
        const placement = await planChildLineage(client, { orgId, parentPodId: root.id, policy: tight });
        const id = uuidv7();
        await client.query(
          `INSERT INTO pods (id, org_id, template_id, user_id, name, provider, state, provider_state,
                             resolved_config, parent_pod_id, lineage_root_id, lineage_depth)
           VALUES ($1, $2, NULL, $3, 'pod', 'sandbox', 'active', 'started', '{}'::jsonb, $4, $5, $6)`,
          [id, orgId, userId, placement.parentPodId, placement.lineageRootId, placement.lineageDepth],
        );
        return id;
      }).catch(() => null);

    const results = await Promise.all([attempt(), attempt(), attempt(), attempt()]);
    assert.equal(results.filter((id) => id !== null).length, 1);
    const live = await query("SELECT id FROM pods WHERE parent_pod_id = $1", [root.id]);
    assert.equal(live.rowCount, 1);
  });

  it("bounds a pod token to the pods it launched", async () => {
    const root = await makePod();
    const child = await makePod({ parent: root });
    const grandchild = await makePod({ parent: child });
    const stranger = await makePod();

    assert.equal(await isDescendantOf({ query }, { orgId, podId: grandchild.id, ancestorPodId: root.id }), true);
    assert.equal(await isDescendantOf({ query }, { orgId, podId: root.id, ancestorPodId: child.id }), false);
    assert.equal(await isDescendantOf({ query }, { orgId, podId: stranger.id, ancestorPodId: root.id }), false);
    assert.equal(await isDescendantOf({ query }, { orgId, podId: root.id, ancestorPodId: root.id }), false);

    const outside = await refused(() =>
      assertPodTokenReach({ query }, { orgId, callerPodId: root.id, podId: stranger.id, action: "delete" }),
    );
    assert.equal(outside.statusCode, 403);
    const itself = await refused(() =>
      assertPodTokenReach({ query }, { orgId, callerPodId: root.id, podId: root.id, action: "delete" }),
    );
    assert.match(itself.message, /cannot delete itself/);
    await assertPodTokenReach({ query }, { orgId, callerPodId: root.id, podId: root.id, action: "inspect", allowSelf: true });
  });

  it("orders a cascade delete deepest first and names live children otherwise", async () => {
    const root = await makePod();
    const child = await makePod({ parent: root });
    const grandchild = await makePod({ parent: child });

    const order = await subtreeDeepestFirst({ query }, { orgId, podId: root.id, includeSelf: true });
    assert.deepEqual(
      order.map((row) => row.id),
      [grandchild.id, child.id, root.id],
    );
    assert.deepEqual(
      (await subtreeDeepestFirst({ query }, { orgId, podId: root.id, includeSelf: false })).map((r) => r.id),
      [grandchild.id, child.id],
    );

    assert.deepEqual(
      (await liveChildren({ query }, { orgId, podId: root.id })).map((c) => c.id),
      [child.id],
    );
    await query("UPDATE pods SET state = 'archived' WHERE id = $1", [child.id]);
    assert.deepEqual(await liveChildren({ query }, { orgId, podId: root.id }), []);
  });

  it("lifts a deleted pod's subtree onto its grandparent", async () => {
    const root = await makePod();
    const child = await makePod({ parent: root });
    const grandchild = await makePod({ parent: child });

    assert.equal(await tx((client) => reparentChildren(client, { orgId, podId: child.id, grandparentPodId: root.id })), 1);
    const moved = await query<{ parent_pod_id: string; lineage_root_id: string; lineage_depth: number }>(
      "SELECT parent_pod_id, lineage_root_id, lineage_depth FROM pods WHERE id = $1",
      [grandchild.id],
    );
    assert.deepEqual(moved.rows[0], { parent_pod_id: root.id, lineage_root_id: root.id, lineage_depth: 1 });
  });

  it("promotes a child to its own lineage root when the deleted pod was the root", async () => {
    const root = await makePod();
    const child = await makePod({ parent: root });
    const grandchild = await makePod({ parent: child });

    await tx((client) => reparentChildren(client, { orgId, podId: root.id, grandparentPodId: null }));
    const rows = await query<{ id: string; parent_pod_id: string | null; lineage_root_id: string; lineage_depth: number }>(
      "SELECT id, parent_pod_id, lineage_root_id, lineage_depth FROM pods WHERE id = ANY($1)",
      [[child.id, grandchild.id]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    assert.deepEqual(byId.get(child.id), {
      id: child.id,
      parent_pod_id: null,
      lineage_root_id: child.id,
      lineage_depth: 0,
    });
    assert.deepEqual(byId.get(grandchild.id), {
      id: grandchild.id,
      parent_pod_id: child.id,
      lineage_root_id: child.id,
      lineage_depth: 1,
    });
  });
});
