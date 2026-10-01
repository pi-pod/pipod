/**
 * Grant allocator races against real Postgres (migrations 053/055).
 *
 * Own DB: `pipod_cost_capacity_test` — never foundation, never production.
 * Proves the parent-review fixes with actual concurrency (not stubs):
 * concurrent revision allocation yields distinct strictly-increasing
 * revisions (single-statement atomic CAS), and the leader lease admits
 * exactly one holder with expiry handover.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import {
  acquireAllocatorLease,
  adoptHostRevision,
  allocateGrantRevision,
  confirmGrant,
  readConfirmedGrants,
  type WaitStore,
} from "../src/server/pods/cpu-fairness.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

const store: WaitStore = {
  query: (text: string, params?: unknown[]) => query(text, params ?? []),
};

describe("grant allocator races (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  before(async () => {
    initPool(databaseUrl!);
  });

  after(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM cpu_grant_ledger");
    await query("DELETE FROM grant_allocator_lease");
  });

  it("allocates distinct strictly-increasing revisions under concurrency", async () => {
    const nowMs = 1_700_000_000_000;
    // Ten concurrent controllers racing the same pair (separate pool checkouts).
    const revisions = await Promise.all(
      Array.from({ length: 10 }, () =>
        allocateGrantRevision(store, { hostId: "race-h", userKey: "u_race", nowMs, cpuCores: 2, ttlMs: 60_000 }),
      ),
    );
    assert.equal(new Set(revisions).size, 10, `reused revision: ${revisions}`);
    const sorted = [...revisions].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i]! > sorted[i - 1]!, `non-increasing: ${sorted}`);
    }
    // Consecutive: no gaps, no jumps (each bump is exactly +1 past nowMs floor).
    assert.equal(sorted[0], nowMs);
    assert.equal(sorted[sorted.length - 1], nowMs + 9);
  });

  it("races different pairs independently", async () => {
    const nowMs = 1_700_000_001_000;
    const [a, b] = await Promise.all([
      allocateGrantRevision(store, { hostId: "h1", userKey: "u_x", nowMs, cpuCores: 1, ttlMs: 60_000 }),
      allocateGrantRevision(store, { hostId: "h2", userKey: "u_x", nowMs, cpuCores: 1, ttlMs: 60_000 }),
    ]);
    assert.equal(a, nowMs);
    assert.equal(b, nowMs);
  });

  it("adopts a host floor without dropping below it", async () => {
    await allocateGrantRevision(store, { hostId: "h1", userKey: "u_y", nowMs: 100, cpuCores: 1, ttlMs: 60_000 });
    await adoptHostRevision(store, { hostId: "h1", userKey: "u_y", hostRevision: 9000 });
    const next = await allocateGrantRevision(store, { hostId: "h1", userKey: "u_y", nowMs: 100, cpuCores: 1, ttlMs: 60_000 });
    assert.ok(next > 9000, `next ${next} must exceed adopted floor`);
  });

  it("confirms exactly the allocated revision over real SQL", async () => {
    const revision = await allocateGrantRevision(store, { hostId: "h1", userKey: "u_z", nowMs: 500, cpuCores: 2, ttlMs: 60_000 });
    assert.equal(await confirmGrant(store, { hostId: "h1", userKey: "u_z", revision: revision + 99, cpuCores: 2 }), false);
    assert.equal(await confirmGrant(store, { hostId: "h1", userKey: "u_z", revision, cpuCores: 2 }), true);
    const grants = await readConfirmedGrants(store);
    const row = grants.find((grant) => grant.userKey === "u_z");
    assert.equal(row?.confirmedCpuCores, 2);
    assert.equal(row?.confirmedRevision, revision);
  });

  it("elects exactly one leader under a 10-way race, with expiry handover", async () => {
    const winners = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        acquireAllocatorLease(store, { holder: `holder-${i}`, ttlMs: 60_000 }),
      ),
    );
    assert.equal(winners.filter(Boolean).length, 1, "exactly one leader must win the race");
    const winner = `holder-${winners.findIndex(Boolean)}`;
    // Winner renews its own lease; anyone else fails until expiry.
    assert.equal(await acquireAllocatorLease(store, { holder: winner, ttlMs: 60_000 }), true);
    assert.equal(await acquireAllocatorLease(store, { holder: "holder-intruder", ttlMs: 60_000 }), false);
    await query(`UPDATE grant_allocator_lease SET expires_at = now() - make_interval(secs => 1) WHERE id = 1`);
    assert.equal(await acquireAllocatorLease(store, { holder: "holder-9", ttlMs: 60_000 }), true);
  });
});
