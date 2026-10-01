import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { OperationLedger } from "../src/core/operations.js";
import type { OperationStatusWire, SandboxInfoWire } from "../src/wire.js";

const RESULT: SandboxInfoWire = {
  id: "sb-1234567890abcdef1234",
  labels: {},
  state: "starting",
  createdAt: new Date(1_000).toISOString(),
  lastActivityAt: new Date(1_000).toISOString(),
  image: "img",
  workdir: "/workspace",
  tier: "warm",
  archiveAfterMinutes: 60,
  idleTimeoutMinutes: 10,
  resources: {},
  ceiling: {},
  owner: null,
  revision: 0,
  runtimeGeneration: 0,
  stoppedAt: null,
  transition: null,
  archive: null,
  hold: null,
  egress: { mode: "allowlist", hosts: [] },
};

function ledger(opts?: { secret?: string; retentionMs?: number; bootId?: string; now?: () => number }) {
  const db = new Database(":memory:");
  const clock = opts?.now ?? (() => 1_000_000);
  const led = new OperationLedger(db, {
    secret: opts?.secret ?? "test-secret-long-enough",
    retentionMs: opts?.retentionMs ?? 60_000,
    bootId: opts?.bootId ?? "boot-1",
    now: clock,
  });
  return { db, led };
}

describe("OperationLedger", () => {

  it("begin validates keys and separates duplicate from conflict", () => {
    const { led } = ledger();
    const fp = led.fingerprint({ image: "img" });
    const other = led.fingerprint({ image: "other" });

    const first = led.begin("op-key-12345678", fp);
    assert.equal(first.outcome, "started");
    assert.equal(first.op.status, "pending");

    const dup = led.begin("op-key-12345678", fp);
    assert.equal(dup.outcome, "duplicate");
    assert.equal(dup.op.status, "pending");

    const conflict = led.begin("op-key-12345678", other);
    assert.equal(conflict.outcome, "conflict");

    assert.throws(() => led.begin("short", fp), (err: unknown) => {
      assert.equal((err as { status: number }).status, 400);
      return true;
    });
  });

  it("succeed then begin replays the stored result", () => {
    const { led } = ledger();
    const fp = led.fingerprint({ image: "img" });
    led.begin("op-key-12345678", fp);
    const done = led.succeed("op-key-12345678", RESULT.id, RESULT);
    assert.equal(done.status, "succeeded");

    const replay = led.begin("op-key-12345678", fp);
    assert.equal(replay.outcome, "duplicate");
    const wire = led.toWire(replay.op);
    assert.equal(wire.status, "succeeded");
    assert.deepEqual(wire.result, RESULT);
    assert.ok(!("error" in wire));
  });

  it("fail round-trips code/message/hint/details through toWire", () => {
    const { led } = ledger();
    const fp = led.fingerprint({ image: "img" });
    led.begin("op-key-12345678", fp);
    const failed = led.fail("op-key-12345678", {
      code: "boom",
      message: "it broke",
      hint: "try again",
      details: {
        kind: "operation",
        operationKey: "op-key-12345678",
        status: "failed",
        sandboxId: null,
      },
      // Anything outside the bounded wire fields must be dropped, never stored.
      extra: "not-a-wire-field",
    } as unknown as Parameters<typeof led.fail>[1]);
    assert.equal(failed.status, "failed");
    const wire = led.toWire(failed);
    assert.deepEqual(wire.error, {
      code: "boom",
      message: "it broke",
      hint: "try again",
      details: { kind: "operation", operationKey: "op-key-12345678", status: "failed", sandboxId: null },
    });
  });

  it("requestCancel flags pending rows and cancel terminates", () => {
    const { led } = ledger();
    assert.equal(led.requestCancel("op-key-missing00"), null);

    const fp = led.fingerprint({ image: "img" });
    led.begin("op-key-12345678", fp);
    const flagged = led.requestCancel("op-key-12345678")!;
    assert.equal(flagged.cancelRequested, true);
    assert.equal(led.toWire(flagged).cancelRequested, true);

    const done = led.succeed("op-key-12345678", RESULT.id, RESULT);
    assert.equal(led.requestCancel("op-key-12345678")!.cancelRequested, done.cancelRequested);

    const fp2 = led.fingerprint({ image: "img2" });
    led.begin("op-key-abcdef12", fp2);
    const cancelled = led.cancel("op-key-abcdef12", "sb-cancelled-id12");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.sandboxId, "sb-cancelled-id12");
    assert.ok(cancelled.finishedAt !== null);
  });

  it("interruptPending quarantines other-boot rows; begin restarts only resolved ones", () => {
    const now = 1_000_000;
    const db = new Database(":memory:");
    const boot1 = new OperationLedger(db, {
      secret: "s",
      retentionMs: 60_000,
      bootId: "boot-1",
      now: () => now,
    });
    const fp = boot1.fingerprint({ image: "img" });
    const fpOther = boot1.fingerprint({ image: "other" });
    boot1.begin("op-key-12345678", fp);
    boot1.begin("op-key-abcdef12", fpOther);

    // Same-boot ledger sees its own pending rows as live: nothing interrupted.
    assert.deepEqual(boot1.interruptPending(), []);

    const boot2 = new OperationLedger(db, {
      secret: "s",
      retentionMs: 60_000,
      bootId: "boot-2",
      now: () => now,
    });
    const interrupted = boot2.interruptPending();
    assert.equal(interrupted.length, 2);
    assert.ok(interrupted.every((op) => op.status === "failed" && op.error?.code === "interrupted"));
    // Nothing is known about the rows until recovery runs: quarantined, no off-host retry.
    assert.ok(interrupted.every((op) => op.resolution === "quarantined"));

    // A quarantined interruption is not restarted: the caller sees the unresolved row.
    const blocked = boot2.begin("op-key-12345678", fp);
    assert.equal(blocked.outcome, "duplicate");
    assert.equal(blocked.op.status, "failed");

    // Once recovery confirms the host is clean, the same key+request restarts fresh.
    boot2.resolve("op-key-12345678", "cleaned");
    const restarted = boot2.begin("op-key-12345678", fp);
    assert.equal(restarted.outcome, "started");
    assert.equal(restarted.op.status, "pending");
    assert.equal(restarted.op.cancelRequested, false);
    assert.equal(restarted.op.error, null);
    assert.equal(restarted.op.resolution, null);
    db.close();
  });

  it("purgeExpired drops only expired terminal rows", () => {
    let now = 1_000_000;
    const { db, led } = ledger({ retentionMs: 1_000, now: () => now });
    const fpDone = led.fingerprint({ image: "done" });
    const fpPending = led.fingerprint({ image: "pending" });
    const fpFresh = led.fingerprint({ image: "fresh" });
    led.begin("op-key-11111111", fpDone);
    led.begin("op-key-22222222", fpPending);
    led.begin("op-key-33333333", fpFresh);

    // finishAt=now, so expiry is finished_at + retentionMs.
    led.succeed("op-key-11111111", RESULT.id, RESULT);
    led.succeed("op-key-33333333", RESULT.id, RESULT);
    const stored = led.get("op-key-11111111")!;
    assert.equal(stored.expiresAt, stored.finishedAt! + 1_000);

    now += 500;
    assert.equal(led.purgeExpired(), 0);

    now += 1_000;
    // The pending row survives even though its own expiry has passed.
    assert.equal(led.purgeExpired(), 2);
    assert.equal(led.get("op-key-11111111"), null);
    assert.equal(led.get("op-key-33333333"), null);
    assert.notEqual(led.get("op-key-22222222"), null);
    db.close();
  });

  it("fail without a sandbox id is preallocation: cross-host retry is safe", () => {
    const { led } = ledger();
    const fp = led.fingerprint({ image: "img" });
    led.begin("op-key-12345678", fp);
    // Refused before any allocation: nothing to clean, retry may go to another host.
    const failed = led.fail("op-key-12345678", { code: "denied", message: "no room" });
    assert.equal(failed.resolution, "preallocation");
    const wire = led.toWire(failed) as OperationStatusWire & {
      resolution: unknown;
      crossHostRetrySafe: boolean;
    };
    assert.equal(wire.resolution, "preallocation");
    assert.equal(wire.crossHostRetrySafe, true);
  });

  it("fail with a sandbox id quarantines until recovery resolves it", () => {
    const { led } = ledger();
    const fp = led.fingerprint({ image: "img" });
    led.begin("op-key-12345678", fp);
    const failed = led.fail("op-key-12345678", { code: "boom", message: "half built" }, "sb-halfbuilt000001");
    assert.equal(failed.resolution, "quarantined");
    const wire = led.toWire(failed) as OperationStatusWire & { crossHostRetrySafe: boolean };
    assert.equal(wire.crossHostRetrySafe, false);

    const cleaned = led.resolve("op-key-12345678", "cleaned");
    assert.equal(cleaned.resolution, "cleaned");
    assert.equal(
      (led.toWire(cleaned) as unknown as { crossHostRetrySafe: boolean }).crossHostRetrySafe,
      true,
    );
  });

  it("cancel without a sandbox id is cleaned; with one it quarantines", () => {
    const { led } = ledger();
    led.begin("op-key-11111111", led.fingerprint({ image: "a" }));
    assert.equal(led.cancel("op-key-11111111").resolution, "cleaned");
    led.begin("op-key-22222222", led.fingerprint({ image: "b" }));
    assert.equal(led.cancel("op-key-22222222", "sb-cancelled-id12").resolution, "quarantined");
  });

  it("migrates a pre-resolution table by adding the column", () => {
    const db = new Database(":memory:");
    // Simulate a DB file written before the resolution column existed.
    db.exec(`
      CREATE TABLE create_operations (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        sandbox_id TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        expires_at INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error_json TEXT,
        boot_id TEXT NOT NULL
      );
    `);
    const led = new OperationLedger(db, { secret: "s", retentionMs: 60_000, bootId: "boot-1" });
    const columns = db.prepare("PRAGMA table_info(create_operations)").all() as Array<{ name: string }>;
    assert.ok(columns.some((col) => col.name === "resolution"));
    // The migrated ledger is fully usable.
    const fp = led.fingerprint({ image: "img" });
    assert.equal(led.begin("op-key-12345678", fp).outcome, "started");
    db.close();
  });

  it("rows survive a reopen by a second ledger", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ops-unit-"));
    try {
      const file = path.join(dir, "ops.db");
      const db1 = new Database(file);
      const led1 = new OperationLedger(db1, { secret: "s", retentionMs: 60_000, bootId: "boot-1" });
      const fp = led1.fingerprint({ image: "img" });
      led1.begin("op-key-12345678", fp);
      led1.succeed("op-key-12345678", RESULT.id, RESULT);
      db1.close();

      const db2 = new Database(file);
      const led2 = new OperationLedger(db2, { secret: "s", retentionMs: 60_000, bootId: "boot-2" });
      const seen = led2.get("op-key-12345678");
      assert.ok(seen !== null && seen.status === "succeeded");
      assert.equal(led2.bySandbox(RESULT.id)?.key, "op-key-12345678");
      db2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
