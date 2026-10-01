/**
 * HTTP-level capacity-wait proof: the REAL AccountClient against a stub HTTP server —
 * waiting → admitted → ready through getPod long-polls, plus a captured DELETE
 * capacity-wait round-trip. Shapes follow capacity-contract.md §1 verbatim.
 */
import { strict as assert } from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { AccountClient, type ApiPod } from "../../src/account/api.js";
import { watchProvisioning } from "../../src/account/launch-provision.js";

const POD_ID = "0198f5a0-0000-7000-8000-0000000000c1";

function podJson(capacityWait: unknown, ready: boolean): Record<string, unknown> {
  return {
    id: POD_ID,
    templateId: null,
    userId: "user-1",
    parentPodId: null,
    hostPodId: null,
    hostPodName: null,
    location: "sandbox",
    lineageDepth: 0,
    forkedFromPodId: null,
    name: "waiter",
    project: null,
    provider: "sandbox",
    state: "active",
    ready,
    connection: ready ? "connected" : "detached",
    initializing: !ready,
    preparationPhase: ready ? "ready" : "provisioning-sandbox",
    sandboxState: ready ? "started" : "provisioning",
    capacityWait,
    stateReason: null,
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    resolvedConfig: {
      clamps: [],
      secretKeys: [],
      secretScopes: null,
      initSteps: null,
      piAuthProviders: null,
      egress: { description: "open", mode: "open" },
      warnings: [],
    },
  };
}

describe("capacity wait over real HTTP", () => {
  let server: http.Server;
  let baseUrl = "";
  const calls: Array<{ method: string; url: string }> = [];
  // Scripted GET /v1/pods/:id answers, in order.
  let script: unknown[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      calls.push({ method: req.method ?? "", url: req.url ?? "" });
      const send = (code: number, body: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "DELETE" && req.url === `/v1/pods/${POD_ID}/capacity-wait`) {
        send(200, {
          cancelled: true,
          capacityWait: {
            state: "cancelled",
            reason: "memory_capacity",
            detail: null,
            attempts: 1,
            deadlineInMs: 59000,
            cancelRequested: true,
          },
        });
        return;
      }
      if (req.method === "GET" && (req.url ?? "").startsWith(`/v1/pods/${POD_ID}`)) {
        const next = script.length > 0 ? script.shift()! : podJson(null, true);
        send(200, next);
        return;
      }
      send(404, { error: "not found", detail: null });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const client = (): AccountClient =>
    new AccountClient(
      {
        serverUrl: baseUrl,
        accessToken: "test-token",
        user: { id: "user-1", email: "test@example.com" },
        orgId: "org-1",
      },
      {},
    );

  const waitingBody = (overrides: Record<string, unknown> = {}): unknown =>
    podJson(
      {
        state: "waiting",
        reason: "memory_capacity",
        detail: {
          kind: "admission",
          reason: "memory_capacity",
          resource: "memory",
          unit: "bytes",
          retryable: true,
          required: 4294967296,
          available: 123456,
        },
        attempts: 0,
        deadlineInMs: 60000,
        cancelRequested: false,
        ...overrides,
      },
      false,
    );

  it("watches waiting → admitted → ready through real long-polls", async () => {
    calls.length = 0;
    script = [
      waitingBody(),
      podJson(
        {
          state: "admitted",
          reason: "memory_capacity",
          detail: null,
          attempts: 3,
          deadlineInMs: 41000,
          cancelRequested: false,
        },
        false,
      ),
      podJson(null, true),
    ];
    const pod = await watchProvisioning(client(), POD_ID, { pollMs: 1, retryMs: 1 });
    assert.equal((pod as ApiPod).ready, true);
    const gets = calls.filter((call) => call.method === "GET");
    assert.ok(gets.length >= 3, `expected ≥3 polls, saw ${gets.length}`);
    assert.ok(
      gets.every((call) => call.url.includes("wait=")),
      "readiness uses the long-poll the contract wakes on state change",
    );
  });

  it("captures a real DELETE capacity-wait round-trip", async () => {
    calls.length = 0;
    const result = await client().cancelCapacityWait(POD_ID);
    assert.deepEqual(result?.cancelled, true);
    assert.equal(result?.capacityWait?.state, "cancelled");
    assert.equal(result?.capacityWait?.cancelRequested, true);
    assert.deepEqual(
      calls,
      [{ method: "DELETE", url: `/v1/pods/${POD_ID}/capacity-wait` }],
      "exactly one cooperative cancel, never a pod delete",
    );
  });

  it("reads a 404 cancel as nothing queued", async () => {
    const missing = await client().cancelCapacityWait("0198f5a0-0000-7000-8000-0000000000ff");
    assert.equal(missing, null);
  });
});
