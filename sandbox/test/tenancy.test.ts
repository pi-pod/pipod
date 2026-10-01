import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ServiceError } from "../src/errors.js";
import { CpuGrants, validateOwnerKey, type FallbackContext } from "../src/core/tenancy.js";
import type { CpuGrantRequest } from "../src/wire.js";

/** Fallback context for tests where the explicit override is in force anyway. */
const CTX: FallbackContext = { budgetCores: 8, activeOwners: 2 };

function request(overrides: Partial<CpuGrantRequest> = {}): CpuGrantRequest {
  return { revision: 1, cpuCores: 4, ttlMs: 10_000, ...overrides };
}

/** Assert the thunk throws the ServiceError with the expected code and status. */
function assertServiceError(
  fn: () => unknown,
  expected: { code: string; status: number },
): ServiceError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ServiceError, `expected ServiceError, got ${String(err)}`);
    assert.equal(err.code, expected.code);
    assert.equal(err.status, expected.status);
    return err;
  }
  assert.fail("expected function to throw");
}

/** A fresh temp-file DB per test, so a second instance can "restart" on the same file. */
async function withTestDb(fn: (db: Database.Database) => void): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tenancy-unit-"));
  const db = new Database(path.join(dir, "tenancy.sqlite"));
  try {
    fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function makeGrants(
  db: Database.Database,
  opts: { fallbackCores?: number | null; bootId?: string; start?: number } = {},
): { grants: CpuGrants; advance: (ms: number) => void } {
  let t = opts.start ?? 100_000;
  const grants = new CpuGrants(db, {
    bootId: opts.bootId ?? "boot-1",
    // NB: `??` would swallow an explicit null override, which means "derive".
    fallbackCores: opts.fallbackCores === undefined ? 1.5 : opts.fallbackCores,
    clock: () => t,
  });
  return {
    grants,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("validateOwnerKey", () => {
  it("accepts a dotted key and rejects malformed or non-string values", () => {
    assert.equal(validateOwnerKey("user_01.a-b"), "user_01.a-b");
    for (const bad of ["../x", "", "a".repeat(65), "has space", "semi;colon"]) {
      const err = assertServiceError(() => validateOwnerKey(bad), { code: "bad_request", status: 400 });
      assert.equal(err.message, "owner.userKey must match ^[A-Za-z0-9._-]{1,64}$");
    }
    for (const bad of [123, null, undefined, {}, ["x"]]) {
      assertServiceError(() => validateOwnerKey(bad), { code: "bad_request", status: 400 });
    }
    // 64 chars is the boundary and still valid.
    assert.equal(validateOwnerKey("a".repeat(64)), "a".repeat(64));
  });
});

describe("CpuGrants", () => {
  it("applies, expires, reports the expiry once, and accepts a newer revision", async () => {
    await withTestDb((db) => {
      const { grants, advance } = makeGrants(db);
      const applied = grants.apply("alice", request({ revision: 1, cpuCores: 4, ttlMs: 10_000 }), CTX);
      assert.deepEqual(applied, {
        applied: true,
        grant: { revision: 1, cpuCores: 4, expiresInMs: 10_000, state: "active" },
        effectiveCores: 4,
      });

      const active = grants.status("alice", CTX);
      assert.equal(active.state, "active");
      assert.equal(active.effectiveCores, 4);
      assert.equal(active.grant?.expiresInMs, 10_000);

      advance(10_001);
      const expired = grants.status("alice", CTX);
      assert.equal(expired.state, "expired");
      assert.equal(expired.grant?.state, "expired");
      assert.equal(expired.grant?.expiresInMs, 0);
      // Past the ttl the parent falls back to the bounded local share.
      assert.equal(expired.effectiveCores, 1.5);

      const first = grants.expireDue(CTX);
      assert.equal(first.length, 1);
      assert.equal(first[0]?.userKey, "alice");
      assert.equal(first[0]?.grant.state, "expired");
      assert.equal(first[0]?.effectiveCores, 1.5);
      // Each expiry is reported exactly once.
      assert.deepEqual(grants.expireDue(CTX), []);

      // A newer revision after expiry is a fresh grant, not a stale retry.
      const renewed = grants.apply("alice", request({ revision: 2, cpuCores: 2, ttlMs: 10_000 }), CTX);
      assert.equal(renewed.applied, true);
      assert.equal(renewed.effectiveCores, 2);
      const again = grants.status("alice", CTX);
      assert.equal(again.state, "active");
      assert.equal(again.effectiveCores, 2);
      assert.deepEqual(grants.counts(), { active: 1, expired: 0 });
    });
  });

  it("rejects equal and lower revisions as stale", async () => {
    await withTestDb((db) => {
      const { grants } = makeGrants(db);
      grants.apply("alice", request({ revision: 5 }), CTX);
      for (const revision of [5, 3]) {
        const err = assertServiceError(() => grants.apply("alice", request({ revision }), CTX), {
          code: "stale_revision",
          status: 409,
        });
        assert.deepEqual(err.details, { kind: "revision", expected: revision, actual: 5 });
      }
      // Other tenants are unaffected by alice's watermark.
      assert.equal(grants.apply("bob", request({ revision: 1 }), CTX).applied, true);
    });
  });

  it("rejects out-of-range ttl and non-positive cores with 400", async () => {
    await withTestDb((db) => {
      const { grants } = makeGrants(db);
      for (const ttlMs of [0, 999, 3_600_001, Number.NaN, Number.POSITIVE_INFINITY]) {
        assertServiceError(() => grants.apply("alice", request({ ttlMs }), CTX), {
          code: "bad_request",
          status: 400,
        });
      }
      for (const cpuCores of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
        assertServiceError(() => grants.apply("alice", request({ cpuCores }), CTX), {
          code: "bad_request",
          status: 400,
        });
      }
      for (const revision of [-1, 1.5, Number.NaN]) {
        assertServiceError(() => grants.apply("alice", request({ revision }), CTX), {
          code: "bad_request",
          status: 400,
        });
      }
      // Range boundaries are accepted.
      assert.equal(grants.apply("edge-lo", request({ ttlMs: 1000 }), CTX).applied, true);
      assert.equal(grants.apply("edge-hi", request({ ttlMs: 3_600_000 }), CTX).applied, true);
    });
  });

  it("a null-cores grant removes the cap while active and falls back after expiry", async () => {
    await withTestDb((db) => {
      const { grants, advance } = makeGrants(db, { fallbackCores: 2 });
      const applied = grants.apply("bob", request({ cpuCores: null, ttlMs: 5000 }), CTX);
      assert.equal(applied.effectiveCores, null);
      const active = grants.status("bob", CTX);
      assert.equal(active.state, "active");
      assert.equal(active.effectiveCores, null);
      assert.equal(active.grant?.cpuCores, null);

      advance(5001);
      const expired = grants.status("bob", CTX);
      assert.equal(expired.state, "expired");
      assert.equal(expired.effectiveCores, 2);
      const reported = grants.expireDue(CTX);
      assert.equal(reported[0]?.effectiveCores, 2);
    });
  });

  it("unknown tenants report none, and forget clears the entry", async () => {
    await withTestDb((db) => {
      const { grants } = makeGrants(db);
      // Before any grant the host is not grant-managed: nothing to fall back to.
      assert.deepEqual(grants.status("ghost", CTX), {
        grant: null,
        state: "none",
        effectiveCores: null,
      });
      grants.apply("alice", request(), CTX);
      // Once managed, an unknown tenant gets the bounded fallback.
      assert.deepEqual(grants.status("ghost", CTX), {
        grant: null,
        state: "none",
        effectiveCores: 1.5,
      });
      assert.deepEqual(grants.counts(), { active: 1, expired: 0 });
      grants.forget("alice");
      assert.deepEqual(grants.status("alice", CTX), {
        grant: null,
        state: "none",
        effectiveCores: 1.5,
      });
      assert.deepEqual(grants.counts(), { active: 0, expired: 0 });
      // Forgetting the last tenant does not silently leave managed mode.
      assert.equal(grants.managedMode(), true);
    });
  });

  it("uses only the injected clock, never the wall clock", async () => {
    await withTestDb((db) => {
      const { grants, advance } = makeGrants(db);
      grants.apply("alice", request({ ttlMs: 10_000 }), CTX);
      const realNow = Date.now;
      try {
        // A wall-clock jump must not move grant boundaries.
        Date.now = () => 9_999_999_999_999;
        assert.equal(grants.status("alice", CTX).state, "active");
        assert.deepEqual(grants.expireDue(CTX), []);
        // Only the monotonic clock advances the grant.
        advance(10_001);
        assert.equal(grants.status("alice", CTX).state, "expired");
        assert.equal(grants.expireDue(CTX).length, 1);
      } finally {
        Date.now = realNow;
      }
    });
  });

  it("keeps the revision high-water across a restart and reads adopted grants as restart-expired", async () => {
    await withTestDb((db) => {
      const first = makeGrants(db, { bootId: "boot-1" });
      first.grants.apply("alice", request({ revision: 5, cpuCores: 4, ttlMs: 10_000 }), CTX);
      assert.equal(first.grants.managedMode(), true);

      // A new instance on the same DB with a different boot id is a restart: the
      // previous boot's monotonic elapsed time is unknowable, so the grant is expired
      // but its revision is still the high-water mark.
      const { grants } = makeGrants(db, { bootId: "boot-2" });
      assert.equal(grants.managedMode(), true);
      const adopted = grants.status("alice", CTX);
      assert.equal(adopted.state, "restart-expired");
      assert.equal(adopted.grant?.state, "restart-expired");
      assert.equal(adopted.grant?.revision, 5);
      assert.equal(adopted.grant?.expiresInMs, 0);
      assert.equal(adopted.effectiveCores, 1.5);
      assert.deepEqual(grants.counts(), { active: 0, expired: 1 });
      assert.deepEqual(grants.degradedOwners(["alice"]), ["alice"]);

      // The first post-boot expireDue reports it, so the Manager applies the fallback
      // to the adopted tenant cgroup — exactly once.
      const due = grants.expireDue(CTX);
      assert.equal(due.length, 1);
      assert.equal(due[0]?.userKey, "alice");
      assert.equal(due[0]?.grant.state, "restart-expired");
      assert.equal(due[0]?.effectiveCores, 1.5);
      assert.deepEqual(grants.expireDue(CTX), []);

      // A delayed pre-restart grant is rejected against the persisted high-water.
      for (const revision of [5, 3]) {
        const err = assertServiceError(() => grants.apply("alice", request({ revision }), CTX), {
          code: "stale_revision",
          status: 409,
        });
        assert.deepEqual(err.details, { kind: "revision", expected: revision, actual: 5 });
      }

      // A newer revision is a live grant again.
      const renewed = grants.apply("alice", request({ revision: 6, cpuCores: 2 }), CTX);
      assert.equal(renewed.effectiveCores, 2);
      assert.equal(grants.status("alice", CTX).state, "active");
      assert.deepEqual(grants.degradedOwners(["alice"]), []);
    });
  });

  it("managedMode starts false, flips on first apply, and survives a restart", async () => {
    await withTestDb((db) => {
      const first = makeGrants(db, { bootId: "boot-1" });
      assert.equal(first.grants.managedMode(), false);
      first.grants.apply("alice", request(), CTX);
      assert.equal(first.grants.managedMode(), true);
      const second = makeGrants(db, { bootId: "boot-2" });
      assert.equal(second.grants.managedMode(), true);
    });
  });

  it("derives a bounded fallback from the context unless overridden", async () => {
    await withTestDb((db) => {
      const { grants } = makeGrants(db, { fallbackCores: null });
      // Even split of the budget.
      assert.equal(grants.fallbackCores({ budgetCores: 7.5, activeOwners: 3 }), 2.5);
      // No live owners: the whole budget is available, still capped by the budget.
      assert.equal(grants.fallbackCores({ budgetCores: 7.5, activeOwners: 0 }), 7.5);
      // Many owners: clamped to the runnable floor, never zero.
      assert.equal(grants.fallbackCores({ budgetCores: 8, activeOwners: 40 }), 0.5);

      const overridden = makeGrants(db, { fallbackCores: 1.25, bootId: "boot-override" });
      assert.equal(overridden.grants.fallbackCores({ budgetCores: 7.5, activeOwners: 3 }), 1.25);
    });
  });

  it("degradedOwners lists only tenants without an active grant while managed", async () => {
    await withTestDb((db) => {
      const { grants, advance } = makeGrants(db);
      // Not grant-managed yet: nobody is degraded.
      assert.deepEqual(grants.degradedOwners(["alice", "bob"]), []);
      grants.apply("alice", request({ revision: 1, ttlMs: 10_000 }), CTX);
      assert.deepEqual(grants.degradedOwners(["alice", "bob"]), ["bob"]);
      // Once the grant lapses the owner degrades too, until a fresh grant arrives.
      advance(10_001);
      assert.deepEqual(grants.degradedOwners(["alice", "bob"]), ["alice", "bob"]);
      grants.apply("alice", request({ revision: 2 }), CTX);
      grants.apply("bob", request({ revision: 1 }), CTX);
      assert.deepEqual(grants.degradedOwners(["alice", "bob"]), []);
    });
  });
});
