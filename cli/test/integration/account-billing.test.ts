/**
 * The SaaS workstation surface and the edition boundary that hides it (plan §3.4, M5).
 *
 * pi pod is one client for two products. The SaaS server (`SANDBOX_HOST_BACKEND=box`) meters a
 * personal workstation per user and sends a flat `workstation` block on `GET /v1/me`; the
 * self-hosted server runs on hardware its operator already pays for and omits the block
 * entirely. The client's whole half of the boundary is the last test in each group: when the
 * block is absent, the surface is not merely empty — it does not exist. Both shapes are
 * asserted, always, because "renders when present" is only half a contract.
 *
 * The field names are the server's, not a guess: every key below is one `workstationSummary()`
 * in `src/server/billing/routes.ts` actually sends. There is no nested `billing` envelope on
 * either `/v1/me` or `/v1/pods`, and no test here invents one.
 */
import { strict as assert } from "node:assert";
import * as http from "node:http";
import { describe, it } from "node:test";
import { AccountClient, type ApiPod } from "../../src/account/api.js";
import type { AccountAuth } from "../../src/account/store.js";
import { billingSummaryLine, parseAccountBilling } from "../../src/account/billing.js";
import { classifyCapacityError, withCapacityHint } from "../../src/account/capacity-errors.js";
import { runAccountList } from "../../src/account/pods.js";
import { PiPodError } from "../../src/errors.js";
import { fakePod } from "../support/fake-account-server.js";

const saas = {
  planKey: "standard",
  planName: "Standard",
  status: "active",
  activeHoursUsed: 12.4,
  includedActiveHours: 200,
  overageHours: 0,
  overageUsdCentsPerHour: 5,
  spendCapUsdCents: 4000,
  projectedSpendUsdCents: 62,
  uncappedSpendUsdCents: 62,
  spendCapState: "ok",
  startsBlocked: false,
  startBlockedReason: null,
  parallelSandboxes: 2,
  workspaceStorageGb: 20,
  currentPeriodEnd: "2026-10-01T00:00:00.000Z",
  trialEndsAt: null,
};

const authFor = (serverUrl: string): AccountAuth => ({
  serverUrl,
  accessToken: "tok",
  user: { id: "u1", email: "dev@example.com" },
  orgId: "org-1",
});

/** A one-route HTTP server, so `responseError` runs for real rather than being simulated. */
async function withRawServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  run: (serverUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("accountBilling reads the workstation block off /v1/me", () => {
  it("parses the real flat block", async () => {
    await withRawServer((_req, res) => {
      sendJson(res, 200, { user: { id: "u1" }, currentOrgId: null, workstation: saas });
    }, async (serverUrl) => {
      const billing = await new AccountClient(authFor(serverUrl)).accountBilling();
      assert.equal(billing?.planName, "Standard");
      assert.equal(billing?.activeHoursUsed, 12.4);
      assert.equal(billing?.spendCapUsdCents, 4000);
    });
  });

  it("is null when the box backend is absent from the response", async () => {
    await withRawServer((_req, res) => {
      sendJson(res, 200, { user: { id: "u1" }, currentOrgId: null });
    }, async (serverUrl) => {
      assert.equal(await new AccountClient(authFor(serverUrl)).accountBilling(), null);
    });
  });

  it("does not read a nested `billing` block that no server serves", async () => {
    await withRawServer((_req, res) => {
      sendJson(res, 200, { user: { id: "u1" }, currentOrgId: null, billing: saas });
    }, async (serverUrl) => {
      assert.equal(await new AccountClient(authFor(serverUrl)).accountBilling(), null);
    });
  });
});

/** `pipod list` end to end, with the workstation surface present and with it absent. */
async function listOutput(
  billing: unknown,
  opts: { quiet?: boolean; podsBilling?: unknown } = {},
): Promise<string> {
  const pod = fakePod({
    id: "0198f5a0-0000-7000-8000-000000000001",
    name: "only",
    project: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
  }) as ApiPod;
  // `pods` carries only pods — a stray extra field must be ignored, not parsed as a plan.
  const stray = opts.podsBilling === undefined ? {} : { billing: opts.podsBilling };
  const client = {
    serverUrl: "https://pods.example",
    listPods: async () => ({ pods: [pod], ...stray }),
    accountBilling: async () => parseAccountBilling(billing),
  } as unknown as AccountClient;
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(
      await runAccountList(client, { all: true, quiet: opts.quiet === true, archived: false, yes: false }),
      0,
    );
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

describe("pipod list workstation footer", () => {
  it("shows the plan, the hours and the cap under the pods (SaaS)", async () => {
    const output = await listOutput(saas);
    assert.match(output, /Standard · 12\.4 of 200 active hours · spend cap \$40 · period ends 2026-10-01/);
    assert.ok(output.indexOf("only") < output.indexOf("active hours"), "the plan line belongs under the pods");
  });

  it("prints nothing at all when the server reports no workstation (self-hosted)", async () => {
    const output = await listOutput(undefined);
    assert.match(output, /only/);
    assert.doesNotMatch(output, /active hours|spend cap|plan|allowance/i);
    // Not an empty line, not a blank heading: the surface is absent, not empty.
    assert.equal(output, await listOutput({}));
  });

  it("ignores a `billing` field the pods envelope never carries", async () => {
    const output = await listOutput(undefined, { podsBilling: saas });
    assert.match(output, /only/);
    assert.doesNotMatch(output, /active hours|spend cap/);
  });

  it("keeps --quiet byte-identical across both editions", async () => {
    const saasQuiet = await listOutput(saas, { quiet: true });
    const selfHostedQuiet = await listOutput(undefined, { quiet: true });
    assert.equal(saasQuiet, selfHostedQuiet);
    assert.equal(saasQuiet, "0198f5a0-0000-7000-8000-000000000001\n");
  });
});

/** The server's 402 refusal, through the real `responseError`, into the billing classifier. */
describe("a 402 workstation start refusal", () => {
  const detail = {
    kind: "billing",
    reason: "spend_cap_reached",
    planKey: "standard",
    activeHoursUsed: 230.25,
    includedActiveHours: 200,
    spendCapUsdCents: 4000,
    projectedSpendUsdCents: 4000,
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    retryable: false,
  };
  const sentence = "your monthly spend cap of $40.00 is reached; raise it to start your workstation again";

  const refuse = async (run: (error: unknown) => void): Promise<void> => {
    await withRawServer((_req, res) => {
      sendJson(res, 402, { error: sentence, detail });
    }, async (serverUrl) => {
      try {
        await new AccountClient(authFor(serverUrl)).listPods();
        assert.fail("expected the server's 402 to be raised");
      } catch (error) {
        run(error);
      }
    });
  };

  it("keeps the server's own sentence and the whole validated detail", async () => {
    await refuse((error) => {
      assert.ok(error instanceof PiPodError);
      assert.equal(error.status, 402);
      assert.match(error.message, /your monthly spend cap of \$40\.00 is reached/);
      assert.deepEqual(error.detail, detail);
      assert.equal(error.transient, false, "a billing refusal must never enter a retry loop");
    });
  });

  it("classifies as a terminal billing block with actionable copy", async () => {
    await refuse((error) => {
      const classified = classifyCapacityError(error);
      assert.equal(classified?.kind, "billing-blocked");
      assert.equal(classified?.retryable, false);
      assert.match(classified!.hint, /spend cap of \$40\.00 is reached/);
      assert.match(classified!.hint, /resets on 2026-10-01/);
      assert.doesNotMatch(classified!.hint, /retry shortly/i);
    });
  });

  it("adds the hint without dropping the detail or changing retry behavior", async () => {
    await refuse((error) => {
      const wrapped = withCapacityHint(error) as PiPodError;
      assert.deepEqual(wrapped.detail, detail);
      assert.equal(wrapped.status, 402);
      assert.equal(wrapped.transient, false);
      assert.match(wrapped.hint ?? "", /Raise the cap/);
    });
  });
});
