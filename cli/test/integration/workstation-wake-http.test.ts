/**
 * The personal-workstation wake over real HTTP: the REAL `AccountClient` against a stub
 * server that answers the exact 503 production answered on 2026-09-10, then admits the
 * launch. This is the end-to-end proof that the typed detail survives the transport — it did
 * not before M5, because the response's `hostId`, `statusHref`, `state` and `operation` were
 * not on the capacity allowlist and the whole detail was dropped on the floor.
 *
 * The stub also proves the client dials `GET /v1/workstations/:hostId` (it polls the durable
 * status while it waits) and that it retries the SAME launch rather than issuing a new one.
 */
import { strict as assert } from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { AccountClient } from "../../src/account/api.js";
import { launchRidingOutBlips } from "../../src/account/launch-provision.js";
import type { AccountLaunchPlan } from "../../src/account/launch-types.js";
import { CancelledError, PiPodError } from "../../src/errors.js";

const HOST = "boat-9622f2fa-48d5-493f-82e4-4c0dee0d54f9";
const POD_ID = "0198f5a0-0000-7000-8000-0000000000d1";

const hostDemandBody = (state: string): Record<string, unknown> => ({
  error: "Your workstation is starting. This may take several minutes",
  detail: {
    kind: "admission",
    reason: "host_starting",
    resource: "transitions",
    unit: "count",
    retryable: true,
    hostId: HOST,
    statusHref: `/v1/workstations/${HOST}`,
    state,
    retryAfterMs: 10_000,
    operation: {
      id: "6ce83b85-2ba3-4384-a201-202a922dc2dc",
      kind: "resume",
      state: "running",
      phase: "command:activate",
      deadlineAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      retryAt: null,
      errorCode: null,
    },
  },
});

function podJson(): Record<string, unknown> {
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
    name: "woken",
    project: null,
    provider: "sandbox",
    state: "active",
    ready: true,
    connection: "connected",
    initializing: false,
    preparationPhase: "ready",
    sandboxState: "started",
    capacityWait: null,
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

describe("workstation wake over real HTTP", () => {
  let server: http.Server;
  let baseUrl = "";
  const calls: Array<{ method: string; url: string }> = [];
  /** How many launches are refused with the host-demand 503 before one is admitted. */
  let refusals = 0;
  let workstationState = "starting";

  before(async () => {
    server = http.createServer((req, res) => {
      calls.push({ method: req.method ?? "", url: req.url ?? "" });
      const send = (code: number, body: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/v1/pods") {
        if (refusals > 0) {
          refusals -= 1;
          send(503, hostDemandBody(workstationState));
          return;
        }
        send(201, { pod: podJson(), report: { clamps: [], secretKeys: [], warnings: [] } });
        return;
      }
      if (req.method === "GET" && req.url === `/v1/workstations/${HOST}`) {
        send(200, { hostId: HOST, state: workstationState, operation: null });
        return;
      }
      if (req.method === "GET" && (req.url ?? "").startsWith("/v1/pods")) {
        send(200, { pods: [] });
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

  const plan = { templateId: null } as unknown as AccountLaunchPlan;
  const body = {} as Parameters<AccountClient["launch"]>[0];

  /** A wait harness with no real sleeping: the clock is what the sleep advances. */
  const harness = () => {
    let clock = 0;
    const lines: string[] = [];
    return {
      lines,
      options: {
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
        progress: (line: string) => lines.push(line),
      },
    };
  };

  it("waits out a starting workstation and lands the same launch", async () => {
    calls.length = 0;
    refusals = 3;
    workstationState = "starting";
    const { options, lines } = harness();
    const { pod } = await launchRidingOutBlips(client(), plan, body, { workstation: options });
    assert.equal(pod.id, POD_ID);

    const launches = calls.filter((call) => call.method === "POST" && call.url === "/v1/pods");
    assert.equal(launches.length, 4, "three refusals, then the launch that landed");
    const polls = calls.filter((call) => call.url === `/v1/workstations/${HOST}`);
    assert.equal(polls.length, 3, "the durable status is polled once per wait cycle");

    assert.match(lines[0]!, /^Your workstation is starting\. This may take several minutes/);
    assert.match(lines[0]!, /files are on its disk and are retained/);
    for (const line of lines) {
      assert.doesNotMatch(line, /fleet|register capacity|lost contact/i);
    }
  });

  it("reads the typed detail off a real 503 instead of dropping it", async () => {
    calls.length = 0;
    refusals = 1;
    workstationState = "stopped";
    const error = await client()
      .launch(body)
      .then(() => null, (e: unknown) => e);
    assert.ok(error instanceof PiPodError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "host_starting");
    const detail = error.detail as Record<string, unknown>;
    assert.equal(detail["hostId"], HOST);
    assert.equal(detail["statusHref"], `/v1/workstations/${HOST}`);
    assert.equal(detail["state"], "stopped");
    assert.equal(detail["retryAfterMs"], 10_000);
    assert.equal((detail["operation"] as Record<string, unknown>)["phase"], "command:activate");
    // The message the user sees is the workstation's, not "the server refused POST /v1/pods".
    assert.match(error.message, /^Your workstation is starting/);
    assert.match(error.hint ?? "", /retained/);
  });

  it("fetches the durable status through the validated host id", async () => {
    calls.length = 0;
    workstationState = "running";
    const status = await client().getWorkstation(HOST);
    assert.deepEqual(status, { hostId: HOST, state: "running", operation: null });
    // A host id that is not one never reaches the network.
    assert.equal(await client().getWorkstation("../../v1/pods"), null);
    assert.equal(calls.filter((call) => call.url.includes("workstations")).length, 1);
  });

  it("leaves the workstation starting when the user interrupts", async () => {
    calls.length = 0;
    refusals = 50;
    workstationState = "starting";
    const { options } = harness();
    // Interrupted after the refusal that opened the wait: Ctrl-C ends this command, not the
    // machine's start, and the copy has to say which one it ended.
    const error = await launchRidingOutBlips(client(), plan, body, {
      workstation: { ...options, cancelled: () => true },
    }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof CancelledError);
    assert.match(error.message, /your workstation keeps starting on the server/);
    assert.equal(calls.filter((call) => call.method === "POST" && call.url === "/v1/pods").length, 1);
  });
});
