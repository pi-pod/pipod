import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("checkPinnedHostEvidence", () => {
  async function healthServer(
    capacity: Record<string, unknown> | null,
  ): Promise<{ url: string; close: () => void }> {
    const { default: http } = await import("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/healthz") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: true,
            version: "t",
            uptimeSeconds: 1,
            hostId: "h",
            sandboxes: { hot: 0, warm: 0, stopped: 0, archived: 0 },
            host: {
              cpus: 4,
              memoryTotalBytes: 16,
              memoryAvailableBytes: 8,
              guaranteeCapacity: { cpu: 3, memoryBytes: 8 },
              committed: { cpu: 0, memoryBytes: 0, diskBytes: 0 },
              diskCapacityBytes: 100,
            },
            ...(capacity === null ? {} : { capacity }),
          }),
        );
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
  }

  function ceilingCapacity(): Record<string, unknown> {
    return {
      contractVersion: 1,
      hostId: "h",
      bootId: "b",
      serviceVersion: "t",
      generation: 1,
      sampledAt: new Date().toISOString(),
      capabilities: {
        maxShape: { cpu: 2, memoryGB: 4, diskGB: 20 },
        standardShape: { cpu: 2, memoryGB: 4, diskGB: 20 },
        resize: { memoryGrowOnline: false, memoryShrink: false, diskGrowOnline: false, diskShrink: false },
        memoryAdmission: "ceiling",
        ownerIdentity: true,
        tenantCgroups: true,
        cpuGrants: false,
        idempotentCreate: true,
        archiveIfStopped: true,
        usageFeed: false,
      },
      memory: {
        budgetBytes: 8, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0,
        debtBytes: 0, availableBytes: 8, hostTotalBytes: 16, hostAvailableBytes: 8,
      },
      cpu: {
        hostCpus: 4, budgetCores: 3, committedFloorCores: 0, ceilingCoresSum: 0,
        sharing: "weighted-shares", loadAvg1: 0, pressureAvg10: 0,
      },
      disk: {
        capacityBytes: 100, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0,
        allocatedBytes: 0, scratchBudgetBytes: 1, scratchUsedBytes: 0, availableBytes: 100,
      },
      transitions: {
        inFlight: 0, maxInFlight: 4, archivesInFlight: 0, maxConcurrentArchives: 2,
        pendingOperations: 0, quarantinedOperations: 0,
      },
      sandboxes: { hot: 0, warm: 0, stopped: 0, archived: 0, error: 0, booting: 0 },
      fairness: { mode: "local-weights", managed: false, activeGrants: 0, expiredGrants: 0, degradedTenants: 0 },
      tenancy: { ownedSandboxes: 0, unownedLive: 0, unownedInitializable: 0, unownedUncertain: 0, requireOwner: false },
    };
  }

  it("verdicts ceiling, floor, missing, malformed, mismatch, stale, and unknown", async () => {
    const { checkPinnedHostEvidence, pinnedEvidenceRefusal } = await import("../src/server/pods/sandboxfleet.js");
    const ceiling = await healthServer(ceilingCapacity());
    const floorCap = ceilingCapacity();
    (floorCap["capabilities"] as Record<string, unknown>)["memoryAdmission"] = "floor";
    const floor = await healthServer(floorCap);
    const legacy = await healthServer(null);
    const malformed = await healthServer({ contractVersion: 999 });
    const impostor = await healthServer({ ...ceilingCapacity(), hostId: "someone-else" });
    const staleCap = ceilingCapacity();
    staleCap["sampledAt"] = new Date(Date.now() - 600_000).toISOString();
    const stale = await healthServer(staleCap);
    try {
      assert.equal(await checkPinnedHostEvidence(ceiling.url, "h"), "ok");
      assert.equal(await checkPinnedHostEvidence(floor.url, "h"), "floor");
      assert.equal(await checkPinnedHostEvidence(legacy.url, "h"), "missing");
      assert.equal(await checkPinnedHostEvidence(malformed.url, "h"), "malformed");
      assert.equal(await checkPinnedHostEvidence(impostor.url, "h"), "mismatch");
      assert.equal(await checkPinnedHostEvidence(stale.url, "h"), "stale");
      assert.equal(await checkPinnedHostEvidence("http://127.0.0.1:1", "h"), "unknown");
      // Every non-ok verdict renders a non-retryable typed refusal.
      for (const verdict of ["missing", "malformed", "mismatch", "stale", "floor", "unknown"] as const) {
        const [message, detail] = pinnedEvidenceRefusal("h", verdict);
        assert.ok(message.length > 0);
        assert.equal(detail["kind"], "admission");
        assert.equal(detail["retryable"], false);
      }
      const [floorMessage, floorDetail] = pinnedEvidenceRefusal("h", "floor");
      assert.match(floorMessage, /floor accounting/);
      assert.equal(floorDetail["reason"], "unsupported_admission");
    } finally {
      ceiling.close();
      floor.close();
      legacy.close();
      malformed.close();
      impostor.close();
      stale.close();
    }
  });
});

