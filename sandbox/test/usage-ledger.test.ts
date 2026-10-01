import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { UsageLedger, type UsageEventInput } from "../src/core/usage.js";

function makeLedger(
  db: Database.Database,
  opts: { now?: () => number; maxRows?: number; maxAgeMs?: number } = {},
): { ledger: UsageLedger; now: () => number; setNow: (ms: number) => void } {
  let t = 1_000_000;
  const setNow = (ms: number): void => {
    t = ms;
  };
  const ledger = new UsageLedger(db, {
    hostId: "h1",
    bootId: "b1",
    maxRows: opts.maxRows ?? 1000,
    maxAgeMs: opts.maxAgeMs ?? 60_000,
    now: opts.now ?? (() => t),
  });
  return { ledger, now: () => t, setNow };
}

function eventInput(id: string, extra: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    kind: "started",
    sandboxId: id,
    ownerKey: "alice",
    runtimeGeneration: 1,
    ...extra,
  };
}


describe("UsageLedger", () => {
  it("record/events/ack round trip and persists acknowledgedSeq across instances", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "usage-ledger-unit-"));
    try {
      const file = path.join(dir, "usage.sqlite");
      const db1 = new Database(file);
      const { ledger } = makeLedger(db1);
      const s1 = ledger.record(eventInput("sb-1", { kind: "created" }));
      const s2 = ledger.record(
        eventInput("sb-1", {
          kind: "stopped",
          durationMs: 1500,
          counters: {
            cpuUsec: 100,
            cpuUserUsec: 60,
            cpuSystemUsec: 40,
            throttledUsec: 0,
            nrPeriods: 10,
            nrThrottled: 0,
            memoryPeakBytes: 1024,
            oomEvents: 0,
            oomKillEvents: 0,
            memoryCurrentBytes: 512,
          },
          detail: { reason: "idle", bytesMoved: 42, ok: true, missing: null },
        }),
      );
      const s3 = ledger.record(eventInput("sb-2", { kind: "started", ownerKey: null }));
      assert.deepEqual([s1, s2, s3], [1, 2, 3]);

      const page = ledger.events(0, 200);
      assert.equal(page.events.length, 3);
      assert.deepEqual(page.events.map((e) => e.seq), [1, 2, 3]);
      assert.equal(page.nextAfter, 3);
      assert.equal(page.oldestRetainedSeq, 1);
      assert.equal(page.droppedBeforeSeq, null);
      assert.equal(page.acknowledgedSeq, 0);
      assert.equal(page.hostId, "h1");
      assert.equal(page.bootId, "b1");
      // ISO instant at the injected clock.
      assert.equal(page.events[0]?.at, new Date(1_000_000).toISOString());
      const stopped = page.events[1];
      assert.equal(stopped?.durationMs, 1500);
      assert.deepEqual(stopped?.counters, {
        cpuUsec: 100,
        cpuUserUsec: 60,
        cpuSystemUsec: 40,
        throttledUsec: 0,
        nrPeriods: 10,
        nrThrottled: 0,
        memoryPeakBytes: 1024,
        oomEvents: 0,
        oomKillEvents: 0,
        memoryCurrentBytes: 512,
      });
      assert.deepEqual(stopped?.detail, { reason: "idle", bytesMoved: 42, ok: true, missing: null });
      assert.equal(page.events[2]?.ownerKey, null);
      // Empty page keeps the cursor.
      assert.equal(ledger.events(3, 200).nextAfter, 3);

      const acked = ledger.ack(2);
      assert.deepEqual(acked, { acknowledgedSeq: 2, retained: 1 });
      assert.deepEqual(
        ledger.events(0, 200).events.map((e) => e.seq),
        [3],
      );
      db1.close();

      // The watermark survives a restart on the same file.
      const db2 = new Database(file);
      try {
        const ledger2 = new UsageLedger(db2, {
          hostId: "h1",
          bootId: "b2",
          maxRows: 1000,
          maxAgeMs: 60_000,
        });
        assert.equal(ledger2.stats().acknowledgedSeq, 2);
        assert.deepEqual(
          ledger2.events(0, 200).events.map((e) => e.seq),
          [3],
        );
      } finally {
        db2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
