/**
 * Atomic global user quota + separate org aggregate (plan §7.1).
 *
 * The deployment cap counts a user's holding pods across ALL orgs; the org policy
 * counts the whole org. `stopping` and unknown states hold. The final check runs
 * inside one transaction under canonical advisory locks with the claim, so
 * simultaneous launches/wakes cannot overshoot.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query, tx } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  acquireQuotaLocks,
  assertQuotaRoomTx,
  countQuota,
} from "../src/server/pods/concurrency.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("atomic global quota (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgA = uuidv7();
  const orgB = uuidv7();
  const user = uuidv7();
  const otherUser = uuidv7();
  const CAP = 20;

  async function makePod(args: {
    org?: string;
    owner?: string;
    providerState?: string;
    provider?: string;
  } = {}): Promise<string> {
    const id = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'quota fixture', $4, $5, 'active', $6, '{}'::jsonb)`,
      [
        id,
        args.org ?? orgA,
        args.owner ?? user,
        args.provider ?? "sandbox",
        `sb-${id}`,
        args.providerState ?? "started",
      ],
    );
    return id;
  }

  /** One atomic contender: check quota and insert a holding row in the same tx. */
  async function tryLaunchHolding(): Promise<boolean> {
    try {
      await tx(async (client) => {
        await acquireQuotaLocks(client, orgA, user);
        await assertQuotaRoomTx(client, {
          orgId: orgA,
          userId: user,
          perUserCap: CAP,
          orgCap: undefined,
        });
        const id = uuidv7();
        await client.query(
          `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
           VALUES ($1, $2, $3, 'racer', 'sandbox', $4, 'active', 'provisioning', '{}'::jsonb)`,
          [id, orgA, user, `sb-${id}`],
        );
      });
      return true;
    } catch {
      return false;
    }
  }

  before(async () => {
    initPool(databaseUrl!);
    for (const [id, name] of [[orgA, "quota a"], [orgB, "quota b"]]) {
      await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [id, name]);
    }
    for (const id of [user, otherUser]) {
      await query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    }
  });

  after(async () => {
    await query("DELETE FROM pods WHERE org_id = ANY($1)", [[orgA, orgB]]);
    for (const id of [user, otherUser]) await query("DELETE FROM users WHERE id = $1", [id]);
    await query("DELETE FROM organizations WHERE id = ANY($1)", [[orgA, orgB]]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM pods WHERE org_id = ANY($1)", [[orgA, orgB]]);
  });

  it("counts the global user budget across orgs, not per org", async () => {
    for (let i = 0; i < 12; i++) await makePod({ org: orgA });
    for (let i = 0; i < 8; i++) await makePod({ org: orgB });
    const counts = await countQuota(orgA, user);
    assert.equal(counts.globalUser, 20);
    assert.equal(counts.org, 12);
    // A 21st launch in EITHER org must refuse: the user is at 20 globally.
    await assert.rejects(
      tx(async (client) => {
        await acquireQuotaLocks(client, orgB, user);
        await assertQuotaRoomTx(client, { orgId: orgB, userId: user, perUserCap: CAP, orgCap: undefined });
      }),
      /caps concurrent pods per user at 20/,
    );
  });

  it("holds stopping and unknown states, frees stopped", async () => {
    await makePod({ providerState: "stopping" });
    await makePod({ providerState: "mystery-future-state" });
    await makePod({ providerState: "stopped" });
    await makePod({ providerState: "archived" });
    const counts = await countQuota(orgA, user);
    assert.equal(counts.globalUser, 2);
    assert.equal(counts.org, 2);
  });

  it("keeps users independent inside one org while the org aggregate narrows", async () => {
    for (let i = 0; i < 5; i++) await makePod({ owner: otherUser });
    const mine = await countQuota(orgA, user);
    assert.equal(mine.globalUser, 0);
    assert.equal(mine.org, 5);
    // Org cap 5 with 5 holding refuses even though this user holds nothing.
    await assert.rejects(
      tx(async (client) => {
        await acquireQuotaLocks(client, orgA, user);
        await assertQuotaRoomTx(client, { orgId: orgA, userId: user, perUserCap: CAP, orgCap: 5 });
      }),
      /org policy caps concurrent pods at 5/,
    );
    // Same org, no org cap: this user still has room.
    await tx(async (client) => {
      await acquireQuotaLocks(client, orgA, user);
      await assertQuotaRoomTx(client, { orgId: orgA, userId: user, perUserCap: CAP, orgCap: undefined });
    });
  });

  it("lets exactly the remaining slots win out of simultaneous launches", async () => {
    for (let i = 0; i < 18; i++) await makePod({});
    const results = await Promise.all(Array.from({ length: 10 }, () => tryLaunchHolding()));
    assert.equal(results.filter(Boolean).length, 2);
    assert.equal((await countQuota(orgA, user)).globalUser, 20);
  });

  it("serializes simultaneous wakes so only one wins the last slot", async () => {
    for (let i = 0; i < 19; i++) await makePod({});
    const sleepers = [await makePod({ providerState: "stopped" }), await makePod({ providerState: "stopped" })];
    const wake = (podId: string) =>
      tx(async (client) => {
        await acquireQuotaLocks(client, orgA, user);
        await assertQuotaRoomTx(client, { orgId: orgA, userId: user, perUserCap: CAP, orgCap: undefined });
        const claimed = await client.query(
          `UPDATE pods SET provider_state = 'starting', provider_state_changed_at = now(), updated_at = now()
           WHERE id = $1 AND provider_state = 'stopped' RETURNING id`,
          [podId],
        );
        if ((claimed.rowCount ?? 0) !== 1) throw new Error("lost the claim race");
      }).then(() => true, () => false);
    const results = await Promise.all(sleepers.map(wake));
    assert.equal(results.filter(Boolean).length, 1);
  });

  it("exempts co-located host children from every budget", async () => {
    for (let i = 0; i < 20; i++) await makePod({});
    for (let i = 0; i < 3; i++) await makePod({ provider: "host", providerState: "started" });
    const counts = await countQuota(orgA, user);
    assert.equal(counts.globalUser, 20);
    // Host children never refuse: they hold no slot (asserted by the count above staying 20).
  });
});
