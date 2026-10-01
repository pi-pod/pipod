import { strict as assert } from "node:assert";
import * as http from "node:http";
import { describe, it } from "node:test";
import { AccountClient } from "../../src/account/api.js";
import { runBillingCommand } from "../../src/account/billing-cli.js";
import type { AccountAuth } from "../../src/account/store.js";
import { PiPodError } from "../../src/errors.js";

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";

const authFor = (serverUrl: string): AccountAuth => ({
  serverUrl,
  accessToken: "tok",
  user: { id: "u1", email: "dev@example.com" },
  orgId: "org-1",
});

interface SeenRequest {
  method: string;
  path: string;
  body: string;
}

const changeableAccount = {
  planKey: "standard",
  planName: "Standard",
  status: "active",
  canSubscribe: false,
  canManageBilling: true,
  canChangePlan: true,
  openPlanChange: null,
  pendingPlanKey: null,
  pendingScheduleUnreadable: false,
  cancelAtPeriodEnd: false,
  availablePlans: [
    { key: "standard", name: "Standard", priceUsdCents: 2000 },
    { key: "pro", name: "Pro", priceUsdCents: 5000 },
  ],
};

// M4 contract: immediate Standard→Pro carries recurringAmountCents = Pro base
// (5000) and nextPeriodAmountCents EQUALS recurring — never 0, never free.
const upgradeQuote = {
  quoteId: QUOTE_ID,
  currentPlan: "standard",
  targetPlan: "pro",
  timing: "immediate",
  amountDueNowCents: 3028,
  recurringAmountCents: 5000,
  nextPeriodAmountCents: 5000,
  currency: "usd",
  currentPeriodEnd: "2026-10-11T00:00:00.000Z",
  effectiveAt: null,
  expiresAt: "2026-09-11T13:00:00.000Z",
  pendingUpdateExpiresAt: null,
  pendingInvoiceId: null,
  state: "quoted",
  items: [
    { priceId: "price_base_pro", kind: "base" },
    { priceId: "price_over_pro", kind: "overage" },
  ],
};

const downgradeQuote = {
  ...upgradeQuote,
  currentPlan: "pro",
  targetPlan: "standard",
  timing: "period_end",
  amountDueNowCents: 0,
  recurringAmountCents: 2000,
  nextPeriodAmountCents: 2000,
  effectiveAt: "2026-10-11T00:00:00.000Z",
};

/**
 * A 200 confirm body: `{ applied, ...quote, account }`. Success is
 * `applied === true` AND the account showing the target plan.
 */
const appliedConfirm = (quote: unknown, planKey: string) => ({
  ...(quote as Record<string, unknown>),
  account: { ...changeableAccount, planKey },
  applied: true,
});

/** Scripted fixture backend: route key → status + JSON body, or a function of requests so far. */
type FixtureRoute =
  | { status: number; body: unknown }
  | ((seen: SeenRequest[]) => { status: number; body: unknown });

function answerRoute(route: FixtureRoute, seen: SeenRequest[]): { status: number; body: unknown } {
  return typeof route === "function" ? route(seen) : route;
}

async function withBillingServer(
  routes: Record<string, FixtureRoute>,
  run: (client: AccountClient, seen: SeenRequest[], stderr: () => string) => Promise<void>,
): Promise<void> {
  const seen: SeenRequest[] = [];
  const lines: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      seen.push({ method: req.method ?? "?", path, body: Buffer.concat(chunks).toString() });
      const route = routes[`${req.method} ${path}`];
      if (!route) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found", detail: null }));
        return;
      }
      const answered = answerRoute(route, seen);
      res.writeHead(answered.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answered.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run(new AccountClient(authFor(`http://127.0.0.1:${port}`)), seen, () => lines.join(""));
  } finally {
    process.stderr.write = originalErr;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const accountRoute = (body: unknown = changeableAccount) => ({
  "GET /v1/billing/account": { status: 200, body },
});
const previewRoute = (body: unknown = upgradeQuote, status = 200) => ({
  "POST /v1/billing/plan-change/preview": { status, body },
});
const confirmRoute = (body: unknown, status = 200) => ({
  "POST /v1/billing/plan-change/confirm": { status, body },
});

/** Account that flips to the target plan once a confirm POST has landed. */
const accountFlippingTo = (planKey: string) => (seen: SeenRequest[]) => ({
  status: 200,
  body: seen.some((r) => r.method === "POST" && r.path === "/v1/billing/plan-change/confirm")
    ? { ...changeableAccount, planKey }
    : changeableAccount,
});
const errorBody = (code: string, detail: unknown = null) => ({ error: code, detail });

describe("pipod billing change", () => {
  it("omits the surface on a static backend (no /v1/billing)", async () => {
    await withBillingServer({}, async (client, seen, stderr) => {
      const code = await runBillingCommand(client, ["change", "--plan", "pro"], {
        ask: () => { throw new Error("must not prompt when omitted"); },
      });
      assert.equal(code, 0);
      assert.match(stderr(), /not available on this server/);
      assert.deepEqual(
        seen.map((r) => `${r.method} ${r.path}`),
        ["GET /v1/billing/account"],
      );
    });
  });

  it("refuses when the account cannot change plans, without previewing", async () => {
    await withBillingServer(
      accountRoute({ ...changeableAccount, canChangePlan: false }),
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro"], { ask: async () => true }),
          (e: unknown) => e instanceof PiPodError && /cannot change plans/.test(e.message),
        );
        assert.ok(!seen.some((r) => r.path.includes("plan-change")), "must not preview");
      },
    );
  });

  it("preview prints due-now with recurring == next period, never free", async () => {
    await withBillingServer(
      { ...accountRoute(), ...previewRoute() },
      async (client, seen, stderr) => {
        const code = await runBillingCommand(client, ["change", "preview", "--plan", "pro"]);
        assert.equal(code, 0);
        const text = stderr();
        assert.match(text, /due now \$30\.28 USD/);
        assert.match(text, /Renews at the pro plan price \(\$50\)/);
        assert.match(text, /Next period \$50 USD/);
        assert.match(text, /never a free month/);
        assert.ok(!/next month free/i.test(text), "must never read as free");
        assert.ok(!/\$0(\.00)? next period/i.test(text), "contract quotes never carry a $0 next period");
        assert.match(text, new RegExp(QUOTE_ID));
        const preview = seen.find((r) => r.path === "/v1/billing/plan-change/preview");
        assert.equal(preview?.body, JSON.stringify({ plan: "pro" }));
        assert.ok(!seen.some((r) => r.path.includes("confirm")), "preview must not confirm");
      },
    );
  });

  it("a legacy $0 next-period on immediate is never called free", async () => {
    const legacyZero = { ...upgradeQuote, nextPeriodAmountCents: 0 };
    await withBillingServer(
      { ...accountRoute(), ...previewRoute(legacyZero) },
      async (client, _seen, stderr) => {
        const code = await runBillingCommand(client, ["change", "preview", "--plan", "pro"]);
        assert.equal(code, 0);
        const text = stderr();
        assert.match(text, /Renews at the pro plan price \(\$50\)/);
        assert.match(text, /never a free month/);
        assert.ok(!/next month free/i.test(text), "a $0 figure is bookkeeping, never free");
        assert.ok(!/free next month/i.test(text));
      },
    );
  });

  it("a quote missing recurringAmountCents is unusable, not rendered", async () => {
    const { recurringAmountCents: _dropped, ...noRecurring } = upgradeQuote;
    await withBillingServer(
      { ...accountRoute(), ...previewRoute(noRecurring) },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "preview", "--plan", "pro"]),
          (e: unknown) => e instanceof PiPodError && /unusable plan-change quote/.test(e.message),
        );
        assert.ok(!seen.some((r) => r.path.includes("confirm")));
      },
    );
  });

  it("preview names the period-end effect and next period for downgrades", async () => {
    await withBillingServer(
      {
        "GET /v1/billing/account": {
          status: 200,
          body: { ...changeableAccount, planKey: "pro", status: "active" },
        },
        ...previewRoute(downgradeQuote),
      },
      async (client, _seen, stderr) => {
        const code = await runBillingCommand(client, ["change", "preview", "--plan", "standard"]);
        assert.equal(code, 0);
        const text = stderr();
        assert.match(text, /at period end/);
        assert.match(text, /Takes effect 2026-10-11/);
        assert.match(text, /next period \$20 USD/);
      },
    );
  });

  it("full flow confirms with {quoteId} only, then reports the refreshed account", async () => {
    await withBillingServer(
      {
        "GET /v1/billing/account": accountFlippingTo("pro"),
        ...previewRoute(),
        ...confirmRoute(appliedConfirm(upgradeQuote, "pro")),
      },
      async (client, seen, stderr) => {
        const code = await runBillingCommand(client, ["change", "--plan", "pro", "--yes"]);
        assert.equal(code, 0);
        const confirms = seen.filter((r) => r.path === "/v1/billing/plan-change/confirm");
        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.body, JSON.stringify({ quoteId: QUOTE_ID }));
        const gets = seen.filter((r) => r.path === "/v1/billing/account");
        assert.equal(gets.length, 2, "account is re-read authoritatively after confirm");
        assert.match(stderr(), /current plan: pro/);
      },
    );
  });

  it("asks an explicit yes naming the charge; no means nothing was sent", async () => {
    await withBillingServer(
      { ...accountRoute(), ...previewRoute() },
      async (client, seen, stderr) => {
        let question = "";
        const code = await runBillingCommand(client, ["change", "--plan", "pro"], {
          ask: async (q) => { question = q; return false; },
        });
        assert.equal(code, 0);
        assert.match(question, /\$30\.28 USD due now/);
        assert.match(stderr(), /not confirmed — nothing was changed/);
        assert.ok(!seen.some((r) => r.path.includes("confirm")));
      },
    );
  });

  it("a stale quote is never auto-confirmed", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        ...previewRoute(),
        ...confirmRoute(errorBody("quote_stale"), 409),
      },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            e.code === "quote_stale" &&
            /nothing was confirmed/.test(e.message),
        );
        assert.equal(seen.filter((r) => r.path.includes("confirm")).length, 1);
      },
    );
  });

  it("canChangePlan=false with an applying open quote resumes the same id, never previews", async () => {
    const applyingAccount = {
      ...changeableAccount,
      canChangePlan: false,
      openPlanChange: { quoteId: QUOTE_ID, state: "applying" },
    };
    await withBillingServer(
      { ...accountRoute(applyingAccount), ...previewRoute() },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            e.code === "open_plan_change_applying" &&
            new RegExp(QUOTE_ID).test(e.message) &&
            /resume/.test(e.message) &&
            new RegExp(QUOTE_ID).test(e.hint ?? ""),
        );
        assert.ok(
          !seen.some((r) => r.path === "/v1/billing/plan-change/preview"),
          "must not mint a fresh quote while one is applying",
        );
        assert.ok(!seen.some((r) => r.path.includes("confirm")));
      },
    );
  });

  it("restart: confirm resumes the same applying quote even when canChangePlan is false", async () => {
    const applyingAccount = {
      ...changeableAccount,
      canChangePlan: false,
      openPlanChange: { quoteId: QUOTE_ID, state: "applying" },
    };
    await withBillingServer(
      {
        "GET /v1/billing/account": (seen: SeenRequest[]) => ({
          status: 200,
          body: seen.some((r) => r.method === "POST" && r.path === "/v1/billing/plan-change/confirm")
            ? { ...changeableAccount, planKey: "pro", openPlanChange: null }
            : applyingAccount,
        }),
        ...confirmRoute(appliedConfirm({ ...upgradeQuote, state: "applying" }, "pro")),
      },
      async (client, seen, stderr) => {
        const code = await runBillingCommand(client, ["change", "confirm", "--quote", QUOTE_ID, "--yes"]);
        assert.equal(code, 0);
        const confirms = seen.filter((r) => r.path === "/v1/billing/plan-change/confirm");
        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.body, JSON.stringify({ quoteId: QUOTE_ID }));
        assert.ok(
          !seen.some((r) => r.path === "/v1/billing/plan-change/preview"),
          "restart must not mint a fresh quote",
        );
        assert.match(stderr(), /current plan: pro/);
      },
    );
  });

  it("402 card_declined fails the quote: portal plus new preview, never a replay, no URL", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        ...previewRoute(),
        ...confirmRoute(
          {
            error: "card_declined",
            detail: {
              kind: "billing",
              reason: "plan_change_payment_failed",
              retryable: false,
              hostedPaymentUrl: "https://pay.example.secret/ho_sted/session_x",
              paymentUrl: "https://pay.example.secret/other",
              checkoutUrl: "https://pay.example.secret/checkout",
              url: "https://pay.example.secret/bare",
            },
          },
          402,
        ),
      },
      async (client, seen, stderr) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            (e as PiPodError).code === "card_declined" &&
            /failed with no pending invoice/.test(e.message) &&
            /still standard/.test(e.message) &&
            /Pro was not granted/.test(e.message) &&
            /portal/.test((e as PiPodError).hint ?? "") &&
            /preview again/.test((e as PiPodError).hint ?? "") &&
            !((e as PiPodError).hint ?? "").includes(QUOTE_ID),
        );
        assert.equal(seen.filter((r) => r.path.includes("confirm")).length, 1);
        const text = stderr();
        assert.ok(!text.includes("https://"), "payment URLs must never be logged");
        assert.ok(!text.includes("pay.example.secret"));
      },
    );
  });

  it("402 authentication_required fails the quote: portal plus new preview, never a replay", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        ...previewRoute(),
        ...confirmRoute({ error: "authentication_required", detail: { kind: "billing" } }, 402),
      },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            (e as PiPodError).code === "authentication_required" &&
            /needs authentication/.test(e.message) &&
            /Pro was not granted/.test(e.message) &&
            /do not retry the failed quote/.test((e as PiPodError).hint ?? "") &&
            !((e as PiPodError).hint ?? "").includes(QUOTE_ID),
        );
        assert.equal(seen.filter((r) => r.path.includes("confirm")).length, 1);
      },
    );
  });

  it("5xx retries the same quote even if expiresAt passed, and grants nothing", async () => {
    const expiredApplying = {
      ...upgradeQuote,
      state: "applying",
      expiresAt: "2026-09-01T00:00:00.000Z",
    };
    await withBillingServer(
      {
        ...accountRoute(),
        ...previewRoute(),
        ...confirmRoute({ error: "internal", detail: null }, 500),
      },
      async (client, seen, stderr) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            /unconfirmed/i.test(e.message) &&
            /may already have applied/i.test(e.message) &&
            /stays applying/.test(e.message) &&
            /retry the same quote/.test(e.message) &&
            !/Pro was not granted/.test(e.message) &&
            !/did not visibly change/.test(e.message) &&
            !/plan did not change/.test(e.message) &&
            !/current plan: pro/.test(e.message) &&
            (e as PiPodError).status !== 402 &&
            new RegExp(QUOTE_ID).test((e as PiPodError).hint ?? "") &&
            /even if it expired/.test((e as PiPodError).hint ?? "") &&
            /retry the same quote/.test((e as PiPodError).hint ?? ""),
        );
        assert.equal(seen.filter((r) => r.path.includes("confirm")).length, 1);
        assert.ok(!stderr().includes("current plan: pro"), "unknown 5xx must not report Pro");
        assert.equal(expiredApplying.state, "applying", "fixture documents the applying retry shape");
      },
    );
  });

  it("confirm --quote on a 500 keeps the same id for retry", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        ...confirmRoute({ error: "internal", detail: null }, 500),
      },
      async (client, seen, stderr) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "confirm", "--quote", QUOTE_ID, "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            /unconfirmed/i.test(e.message) &&
            /may already have applied/i.test(e.message) &&
            !/Pro was not granted/.test(e.message) &&
            !/did not visibly change/.test(e.message) &&
            !/plan did not change/.test(e.message) &&
            !/current plan: pro/.test(e.message) &&
            new RegExp(QUOTE_ID).test((e as PiPodError).hint ?? "") &&
            /even if it expired/.test((e as PiPodError).hint ?? "") &&
            /retry the same quote/.test((e as PiPodError).hint ?? ""),
        );
        const confirms = seen.filter((r) => r.path === "/v1/billing/plan-change/confirm");
        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.body, JSON.stringify({ quoteId: QUOTE_ID }));
        assert.ok(!stderr().includes("current plan: pro"), "unknown 500 must not report Pro");
      },
    );
  });

  it("a 200 with account Pro but missing applied never grants Pro", async () => {
    // The wire is `{ applied, ...quote, account }`: missing `applied` is not success.
    await withBillingServer(
      {
        "GET /v1/billing/account": accountFlippingTo("pro"),
        ...previewRoute(),
        ...confirmRoute({ ...upgradeQuote, account: { ...changeableAccount, planKey: "pro" } }),
      },
      async (client, seen, stderr) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            (e as PiPodError).code === "plan_change_not_applied" &&
            /not applied/.test(e.message) &&
            /Pro was not granted/.test(e.message),
        );
        assert.ok(!stderr().includes("current plan: pro"), "missing applied must not report Pro");
        assert.equal(seen.filter((r) => r.path.includes("confirm")).length, 1);
      },
    );
  });

  it("a 200 with applied:false but account Pro never grants Pro", async () => {
    await withBillingServer(
      {
        "GET /v1/billing/account": accountFlippingTo("pro"),
        ...previewRoute(),
        ...confirmRoute({
          ...upgradeQuote,
          account: { ...changeableAccount, planKey: "pro" },
          applied: false,
        }),
      },
      async (client, seen, stderr) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            (e as PiPodError).code === "plan_change_not_applied" &&
            /Pro was not granted/.test(e.message),
        );
        assert.ok(!stderr().includes("current plan: pro"), "applied:false must not report Pro");
        assert.equal(seen.filter((r) => r.path.includes("confirm")).length, 1);
      },
    );
  });

  it("a 200 with applied:true but account still Standard never grants Pro", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        ...previewRoute(),
        ...confirmRoute({
          ...upgradeQuote,
          account: { ...changeableAccount, planKey: "standard" },
          applied: true,
        }),
      },
      async (client, seen, stderr) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            (e as PiPodError).code === "plan_change_not_applied" &&
            /still standard/.test(e.message) &&
            /Pro was not granted/.test(e.message),
        );
        assert.ok(!stderr().includes("current plan: pro"));
        assert.equal(seen.filter((r) => r.path.includes("confirm")).length, 1);
      },
    );
  });

  it("a 200 confirm with applied:true and pendingPlanKey grants a period-end downgrade", async () => {
    await withBillingServer(
      {
        "GET /v1/billing/account": (seen: SeenRequest[]) => ({
          status: 200,
          body: seen.some((r) => r.method === "POST" && r.path === "/v1/billing/plan-change/confirm")
            ? { ...changeableAccount, planKey: "pro", pendingPlanKey: "standard" }
            : { ...changeableAccount, planKey: "pro", status: "active" },
        }),
        ...confirmRoute({
          ...downgradeQuote,
          account: { ...changeableAccount, planKey: "pro", pendingPlanKey: "standard" },
          applied: true,
        }),
      },
      async (client, seen, stderr) => {
        const code = await runBillingCommand(client, ["change", "confirm", "--quote", QUOTE_ID, "--yes"]);
        assert.equal(code, 0);
        assert.match(stderr(), /takes effect at the end of the current period/);
        assert.equal(seen.filter((r) => r.path.includes("confirm")).length, 1);
      },
    );
  });

  it("a 200 with applied:true that leaves Standard is plan_change_not_applied, not Pro", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        ...confirmRoute({
          ...upgradeQuote,
          account: { ...changeableAccount, planKey: "standard" },
          applied: true,
        }),
      },
      async (client, seen, stderr) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "confirm", "--quote", QUOTE_ID, "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            (e as PiPodError).code === "plan_change_not_applied" &&
            /still/.test(e.message) &&
            /Pro was not granted/.test(e.message),
        );
        assert.ok(!stderr().includes("current plan: pro"));
        assert.equal(seen.filter((r) => r.path.includes("confirm")).length, 1);
      },
    );
  });

  it("a cap refusal never raises the cap", async () => {
    await withBillingServer(
      { ...accountRoute(), ...previewRoute(errorBody("cap_below_new_base"), 409) },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            e.code === "cap_below_new_base" &&
            /cap was left alone/.test(e.message),
        );
        assert.ok(!seen.some((r) => r.path.includes("confirm")));
        assert.ok(!seen.some((r) => r.method === "PUT"), "no spend-cap write may happen");
      },
    );
  });

  it("confirm --quote retries the same quote id", async () => {
    await withBillingServer(
      {
        "GET /v1/billing/account": accountFlippingTo("pro"),
        ...confirmRoute(appliedConfirm(upgradeQuote, "pro")),
      },
      async (client, seen, stderr) => {
        const code = await runBillingCommand(client, ["change", "confirm", "--quote", QUOTE_ID, "--yes"]);
        assert.equal(code, 0);
        const confirms = seen.filter((r) => r.path === "/v1/billing/plan-change/confirm");
        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.body, JSON.stringify({ quoteId: QUOTE_ID }));
        assert.match(stderr(), /current plan: pro/);
      },
    );
  });

  it("confirm rejects a malformed quote id without any request", async () => {
    await withBillingServer({ ...accountRoute() }, async (client, seen) => {
      await assert.rejects(
        () => runBillingCommand(client, ["change", "confirm", "--quote", "not-a-uuid"]),
        (e: unknown) => e instanceof PiPodError && /--quote <quoteId>/.test(e.message),
      );
      assert.deepEqual(seen, []);
    });
  });

  it("an unusable quote body is reported, not rendered", async () => {
    await withBillingServer(
      { ...accountRoute(), ...previewRoute({ nonsense: true }) },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "preview", "--plan", "pro"]),
          (e: unknown) => e instanceof PiPodError && /unusable plan-change quote/.test(e.message),
        );
        assert.ok(!seen.some((r) => r.path.includes("confirm")));
      },
    );
  });

  it("409 plan_change_in_flight on preview resumes that id, never a new preview", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        "POST /v1/billing/plan-change/preview": {
          status: 409,
          body: { error: "plan_change_in_flight", detail: { quoteId: QUOTE_ID, state: "applying" } },
        },
      },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "preview", "--plan", "pro"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            e.code === "plan_change_in_flight" &&
            new RegExp(QUOTE_ID).test(e.message) &&
            /resume/.test(e.message) &&
            new RegExp(QUOTE_ID).test(e.hint ?? ""),
        );
        assert.ok(!seen.some((r) => r.path.includes("confirm")));
      },
    );
  });

  it("409 plan_change_in_flight on confirm retries the same id", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        "POST /v1/billing/plan-change/confirm": {
          status: 409,
          body: { error: "plan_change_in_flight", detail: { quoteId: QUOTE_ID, state: "applying" } },
        },
      },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "confirm", "--quote", QUOTE_ID, "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            e.code === "plan_change_in_flight" &&
            new RegExp(QUOTE_ID).test(e.hint ?? "") &&
            /even if it expired/.test(e.hint ?? ""),
        );
        const confirms = seen.filter((r) => r.path === "/v1/billing/plan-change/confirm");
        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.body, JSON.stringify({ quoteId: QUOTE_ID }));
      },
    );
  });

  it("409 plan_change_effect_unknown on confirm keeps the same quote id, 0 extra previews", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        ...previewRoute(),
        "POST /v1/billing/plan-change/confirm": {
          status: 409,
          body: { error: "plan_change_effect_unknown", detail: { quoteId: QUOTE_ID, retryable: true } },
        },
      },
      async (client, seen, stderr) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            e.code === "plan_change_effect_unknown" &&
            /unconfirmed/i.test(e.message) &&
            /may already have applied/i.test(e.message) &&
            /retry the same quote/.test(e.message) &&
            !/Pro was not granted/.test(e.message) &&
            !/did not visibly change/.test(e.message) &&
            !/plan did not change/.test(e.message) &&
            !/current plan: pro/.test(e.message) &&
            !/nothing was confirmed/.test(e.message) &&
            new RegExp(QUOTE_ID).test(e.hint ?? "") &&
            /retry the same quote/.test(e.hint ?? "") &&
            /even if it expired/.test(e.hint ?? ""),
        );
        assert.equal(seen.filter((r) => r.path === "/v1/billing/plan-change/preview").length, 1, "no extra preview after the unknown 409");
        const confirms = seen.filter((r) => r.path === "/v1/billing/plan-change/confirm");
        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.body, JSON.stringify({ quoteId: QUOTE_ID }));
        assert.ok(!stderr().includes("https://"), "payment URLs must never be logged");
        assert.ok(!stderr().includes("current plan: pro"), "unknown 409 must not report Pro");
      },
    );
  });

  it("plan_change_effect_unknown is not treated as stale", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        "POST /v1/billing/plan-change/confirm": {
          status: 409,
          body: { error: "plan_change_effect_unknown", detail: { quoteId: QUOTE_ID, retryable: true } },
        },
      },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "confirm", "--quote", QUOTE_ID, "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            e.code === "plan_change_effect_unknown" &&
            /unconfirmed/i.test(e.message) &&
            /may already have applied/i.test(e.message) &&
            !/Pro was not granted/.test(e.message) &&
            !/did not visibly change/.test(e.message) &&
            !/plan did not change/.test(e.message) &&
            !/nothing was confirmed/.test(e.message) &&
            !/preview again/.test(e.hint ?? "") &&
            new RegExp(QUOTE_ID).test(e.hint ?? "") &&
            /retry the same quote/.test(e.hint ?? ""),
        );
        assert.ok(
          !seen.some((r) => r.path === "/v1/billing/plan-change/preview"),
          "an unknown effect must never mint a new preview",
        );
      },
    );
  });

  it("plan_change_effect_unknown with retryable:true does not become a 402", async () => {
    await withBillingServer(
      {
        ...accountRoute(),
        ...previewRoute(),
        "POST /v1/billing/plan-change/confirm": {
          status: 409,
          body: { error: "plan_change_effect_unknown", detail: { quoteId: QUOTE_ID, retryable: true } },
        },
      },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            (e as PiPodError).code === "plan_change_effect_unknown" &&
            (e as PiPodError).status === 409 &&
            /unconfirmed/i.test((e as PiPodError).message) &&
            /may already have applied/i.test((e as PiPodError).message) &&
            !/Pro was not granted/.test((e as PiPodError).message) &&
            !/did not visibly change/.test((e as PiPodError).message) &&
            !/plan did not change/.test((e as PiPodError).message) &&
            !/portal/.test((e as PiPodError).hint ?? "") &&
            !/do not retry the failed quote/.test((e as PiPodError).hint ?? "") &&
            /retry the same quote/.test((e as PiPodError).hint ?? ""),
        );
        assert.equal(seen.filter((r) => r.path.includes("confirm")).length, 1);
      },
    );
  });

  it("plan_change_effect_unknown with canChangePlan:false still resumes this id", async () => {
    const applyingAccount = {
      ...changeableAccount,
      canChangePlan: false,
      openPlanChange: { quoteId: QUOTE_ID, state: "applying" },
    };
    await withBillingServer(
      {
        ...accountRoute(applyingAccount),
        "POST /v1/billing/plan-change/confirm": {
          status: 409,
          body: { error: "plan_change_effect_unknown", detail: { quoteId: QUOTE_ID, retryable: true } },
        },
      },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "confirm", "--quote", QUOTE_ID, "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            e.code === "plan_change_effect_unknown" &&
            /unconfirmed/i.test(e.message) &&
            /may already have applied/i.test(e.message) &&
            !/Pro was not granted/.test(e.message) &&
            !/did not visibly change/.test(e.message) &&
            !/plan did not change/.test(e.message) &&
            new RegExp(QUOTE_ID).test(e.hint ?? "") &&
            /retry the same quote/.test(e.hint ?? "") &&
            /even if it expired/.test(e.hint ?? ""),
        );
        const confirms = seen.filter((r) => r.path === "/v1/billing/plan-change/confirm");
        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.body, JSON.stringify({ quoteId: QUOTE_ID }));
        assert.ok(
          !seen.some((r) => r.path === "/v1/billing/plan-change/preview"),
          "restart must not mint a fresh quote",
        );
      },
    );
  });

  it("canResumePlanChange resumes the same applying quote even when canChangePlan is false", async () => {
    const resumableAccount = {
      ...changeableAccount,
      canChangePlan: false,
      canResumePlanChange: true,
      openPlanChange: { quoteId: QUOTE_ID, state: "applying", targetPlan: "pro" },
    };
    await withBillingServer(
      {
        "GET /v1/billing/account": (seen: SeenRequest[]) => ({
          status: 200,
          body: seen.some((r) => r.method === "POST" && r.path === "/v1/billing/plan-change/confirm")
            ? { ...changeableAccount, planKey: "pro", openPlanChange: null }
            : resumableAccount,
        }),
        ...confirmRoute({
          ...upgradeQuote,
          state: "applying",
          account: { ...changeableAccount, planKey: "pro" },
          applied: true,
        }),
      },
      async (client, seen, stderr) => {
        const code = await runBillingCommand(client, ["change", "confirm", "--quote", QUOTE_ID, "--yes"]);
        assert.equal(code, 0);
        const confirms = seen.filter((r) => r.path === "/v1/billing/plan-change/confirm");
        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.body, JSON.stringify({ quoteId: QUOTE_ID }));
        assert.ok(
          !seen.some((r) => r.path === "/v1/billing/plan-change/preview"),
          "resume must not mint a fresh quote",
        );
        assert.match(stderr(), /current plan: pro/);
      },
    );
  });

  it("lost confirm: flow with canResumePlanChange blocks with the same resume id", async () => {
    const resumableAccount = {
      ...changeableAccount,
      canChangePlan: false,
      canResumePlanChange: true,
      openPlanChange: { quoteId: QUOTE_ID, state: "applying", targetPlan: "pro" },
    };
    await withBillingServer(
      { ...accountRoute(resumableAccount), ...previewRoute() },
      async (client, seen) => {
        await assert.rejects(
          () => runBillingCommand(client, ["change", "--plan", "pro", "--yes"]),
          (e: unknown) =>
            e instanceof PiPodError &&
            e.code === "open_plan_change_applying" &&
            new RegExp(QUOTE_ID).test(e.message) &&
            new RegExp(QUOTE_ID).test(e.hint ?? ""),
        );
        assert.ok(
          !seen.some((r) => r.path === "/v1/billing/plan-change/preview"),
          "a lost confirm must not mint a fresh quote",
        );
      },
    );
  });

  it("timeout/network loss stays unconfirmed and retries the same quote, never denies", async () => {
    const parsedAccount = {
      ...changeableAccount,
      canResumePlanChange: false,
      planPrices: [
        { key: "standard", name: "Standard", priceUsdCents: 2000 },
        { key: "pro", name: "Pro", priceUsdCents: 5000 },
      ],
    };
    const timeoutClient = {
      billingAccountPlan: async () => parsedAccount,
      previewPlanChange: async () => upgradeQuote,
      confirmPlanChange: async (): Promise<never> => {
        throw new Error("fetch failed");
      },
    } as unknown as AccountClient;
    await assert.rejects(
      () => runBillingCommand(timeoutClient, ["change", "--plan", "pro", "--yes"]),
      (e: unknown) =>
        e instanceof PiPodError &&
        (e as PiPodError).code === "confirm_unknown" &&
        (e as PiPodError).transient === true &&
        /unconfirmed/i.test(e.message) &&
        /may already have applied/i.test(e.message) &&
        /retry the same quote/.test(e.message) &&
        !/Pro was not granted/.test(e.message) &&
        !/did not visibly change/.test(e.message) &&
        !/plan did not change/.test(e.message) &&
        !/current plan: pro/.test(e.message) &&
        new RegExp(QUOTE_ID).test((e as PiPodError).hint ?? "") &&
        /even if it expired/.test((e as PiPodError).hint ?? "") &&
        /retry the same quote/.test((e as PiPodError).hint ?? ""),
    );
  });
});
