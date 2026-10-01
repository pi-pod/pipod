/**
 * Authenticated Stripe checkout and portal entrypoints.
 *
 * The server owns entitlement. Return pages (`/billing/success` etc.) are
 * landing copy only — a query string never grants a plan. `trial: true` is
 * the request for a trial; a closed public-trial gate refuses it. Paid
 * subscribe is explicit `trial: false`.
 */
import { spawn } from "node:child_process";
import { EXIT, PiPodError } from "../errors.js";
import { info } from "../log.js";
import { confirm } from "../prompt.js";
import type { AccountClient } from "./api.js";
import {
  formatUsdCents,
  type BillingAccountPlan,
  type BillingPlanKey,
  type PlanChangeQuoteView,
} from "./billing.js";

const HTTPS = /^https:\/\//i;
const PLANS = new Set(["standard", "pro"]);

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return;
  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // URL already printed.
  }
}

function requireHttpsUrl(value: unknown, what: string): string {
  if (typeof value !== "string" || !HTTPS.test(value) || value.length > 2048) {
    throw new PiPodError(`the server did not return a usable ${what} URL`);
  }
  return value;
}

export async function runBillingCommand(client: AccountClient, args: string[], deps: BillingCommandDeps = {}): Promise<number> {
  const [verb, ...rest] = args;
  if (!verb || verb === "help" || verb === "--help") {
    info(`Usage: pipod billing checkout [--plan standard|pro] [--trial]
       pipod billing portal
       pipod billing change --plan standard|pro [--yes]
       pipod billing change preview --plan standard|pro
       pipod billing change confirm --quote <quoteId> [--yes]

checkout  Open Stripe Checkout (authenticated). Sends trial:false (paid)
          unless --trial. Closed public trial refuses --trial with 402.
portal    Open the Stripe billing portal for the existing subscription.
change    Preview a Standard<->Pro plan change and, after an explicit yes,
          confirm it. Upgrades bill proration immediately; downgrades take
          effect at the end of the current period. Offered only when the
          server reports the account can change plans. When a confirm is lost
          (canChangePlan false with an applying open quote), resume the same
          quote id instead of previewing again.
preview   Show the priced quote without confirming anything.
confirm   Confirm a previously previewed quote by id. After a 5xx, a network
          loss, or a 409 plan_change_effect_unknown retry the SAME quote id
          even if its expiresAt passed; after a 402 card_declined/
          authentication_required the quote failed, so fix the card in the
          portal and preview again (never replay the key).

Returning from Checkout or the portal does not change your plan by itself —
refresh against the server. Do not infer entitlement from URL query strings.
A plan change never takes effect without your explicit yes, and a stale or
expired quote is never auto-confirmed: preview again instead.

Install: GitHub release tarball or a git clone + npm run build. Public npm 404
is not a supported distribution path.`);
    return EXIT.OK;
  }
  if (verb === "checkout") return runCheckout(client, rest);
  if (verb === "portal") return runPortal(client);
  if (verb === "change") return runPlanChange(client, rest, deps);
  throw new PiPodError(`unknown billing command ${verb}`, {
    hint: "pipod billing checkout | pipod billing portal | pipod billing change --plan pro",
    exitCode: EXIT.USAGE,
  });
}

async function runCheckout(client: AccountClient, args: string[]): Promise<number> {
  let plan: "standard" | "pro" = "standard";
  let trial = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--plan") {
      const v = args[++i];
      if (!v || !PLANS.has(v)) throw new PiPodError("usage: --plan standard|pro", { exitCode: EXIT.USAGE });
      plan = v as "standard" | "pro";
    } else if (a === "--trial") trial = true;
    else if (a === "--paid") trial = false;
    else throw new PiPodError(`unknown checkout flag ${a}`, { exitCode: EXIT.USAGE });
  }
  const session = await client.createCheckoutSession({ plan, trial });
  const url = requireHttpsUrl(session.url, "checkout");
  info(`opening Stripe Checkout (${session.trial ? "trial requested" : "paid"})`);
  info("return pages do not grant a plan; the server is the source of truth after webhook/refresh");
  openBrowser(url);
  return EXIT.OK;
}

async function runPortal(client: AccountClient): Promise<number> {
  const session = await client.createPortalSession();
  const url = requireHttpsUrl(session.url, "portal");
  info("opening the billing portal");
  info("return pages do not grant a plan; the server is the source of truth");
  openBrowser(url);
  return EXIT.OK;
}

// --- plan change (M5; quotes from POST /v1/billing/plan-change/*) -----------------

/** Test seam: the default asks the terminal; tests inject answers. */
export interface BillingCommandDeps {
  ask?: (question: string) => Promise<boolean>;
}

type PlanChangeForm =
  | { kind: "flow"; plan: BillingPlanKey; yes: boolean }
  | { kind: "preview"; plan: BillingPlanKey }
  | { kind: "confirm"; quoteId: string; yes: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGE_USAGE = "pipod billing change --plan standard|pro [--yes]";
const CHANGE_PREVIEW_USAGE = "pipod billing change preview --plan standard|pro";
const CHANGE_CONFIRM_USAGE = "pipod billing change confirm --quote <quoteId> [--yes]";

function usageError(message: string, usage: string): PiPodError {
  return new PiPodError(message, { hint: `usage: ${usage}`, exitCode: EXIT.USAGE });
}

function parseChangeArgs(args: string[]): PlanChangeForm {
  let form: "flow" | "preview" | "confirm" = "flow";
  let plan: BillingPlanKey | undefined;
  let quoteId: string | undefined;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "preview" && form === "flow" && plan === undefined && quoteId === undefined) {
      form = "preview";
    } else if (a === "confirm" && form === "flow" && plan === undefined && quoteId === undefined) {
      form = "confirm";
    } else if (a === "--plan") {
      const v = args[++i];
      if (!v || (v !== "standard" && v !== "pro")) throw usageError("usage: --plan standard|pro", CHANGE_USAGE);
      plan = v;
    } else if (a === "--quote") {
      const v = args[++i];
      if (!v || !UUID.test(v)) throw usageError("usage: --quote <quoteId> (the id from a preview)", CHANGE_CONFIRM_USAGE);
      quoteId = v;
    } else if (a === "--yes") {
      yes = true;
    } else {
      throw usageError(
        `unknown change flag ${a}`,
        form === "confirm" ? CHANGE_CONFIRM_USAGE : form === "preview" ? CHANGE_PREVIEW_USAGE : CHANGE_USAGE,
      );
    }
  }
  if (form === "preview") {
    if (!plan || quoteId !== undefined || yes) throw usageError("preview takes only --plan", CHANGE_PREVIEW_USAGE);
    return { kind: "preview", plan };
  }
  if (form === "confirm") {
    if (!quoteId || plan !== undefined) throw usageError("confirm takes only --quote", CHANGE_CONFIRM_USAGE);
    return { kind: "confirm", quoteId, yes };
  }
  if (!plan || quoteId !== undefined) throw usageError("change takes --plan", CHANGE_USAGE);
  return { kind: "flow", plan, yes };
}

function money(cents: number, currency: string): string {
  if (currency === "usd") return formatUsdCents(cents);
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function renewalPrice(account: BillingAccountPlan, target: BillingPlanKey): string | null {
  const entry = account.planPrices.find((p) => p.key === target);
  if (!entry || entry.priceUsdCents === undefined) return null;
  return formatUsdCents(entry.priceUsdCents);
}

/**
 * Due-now versus period-end/recurring. On an immediate upgrade the quote's
 * `recurringAmountCents` is the target licensed base (e.g. $50) and
 * `nextPeriodAmountCents` equals it — never 0, never "next month free". A
 * zero next-period on an immediate quote is stale bookkeeping, never a free
 * month. The renewal is named from the quote's recurring amount; the
 * account's plan prices are only a fallback when they agree.
 */
function printQuote(quote: PlanChangeQuoteView, account: BillingAccountPlan): void {
  const direction = `${quote.currentPlan} → ${quote.targetPlan}`;
  if (quote.timing === "immediate") {
    const renewal = renewalPrice(account, quote.targetPlan);
    const recurring = money(quote.recurringAmountCents, quote.currency);
    const next = money(quote.nextPeriodAmountCents, quote.currency);
    const renewalNote =
      quote.currentPeriodEnd !== null
        ? `Renews at the ${quote.targetPlan} plan price (${recurring}) starting ${day(quote.currentPeriodEnd)}. Next period ${next} ${quote.currency.toUpperCase()}.`
        : `Renews at the ${quote.targetPlan} plan price (${recurring}). Next period ${next} ${quote.currency.toUpperCase()}.`;
    info(`plan change ${direction} (immediate): due now ${money(quote.amountDueNowCents, quote.currency)} ${quote.currency.toUpperCase()}`);
    info(renewalNote);
    if (renewal !== null && renewal !== recurring) {
      info(`(account lists the ${quote.targetPlan} plan price as ${renewal}.)`);
    }
    info("Recurring and next-period amounts come from the quote — never a free month.");
  } else {
    const effective = quote.effectiveAt ?? quote.currentPeriodEnd;
    info(`plan change ${direction} (at period end): due now ${money(quote.amountDueNowCents, quote.currency)} ${quote.currency.toUpperCase()}`);
    info(
      effective !== null
        ? `Takes effect ${day(effective)}; next period ${money(quote.nextPeriodAmountCents, quote.currency)} ${quote.currency.toUpperCase()}.`
        : `Next period ${money(quote.nextPeriodAmountCents, quote.currency)} ${quote.currency.toUpperCase()}.`,
    );
  }
  info(`Quote ${quote.quoteId} expires ${day(quote.expiresAt)}.`);
}

function printAccountContext(account: BillingAccountPlan): void {
  if (account.pendingPlanKey) info(`A change to ${account.pendingPlanKey} is already pending.`);
  if (account.pendingScheduleUnreadable) info("The pending schedule could not be read; the portal has the details.");
  if (account.cancelAtPeriodEnd) info("This subscription is set to cancel at the end of the current period.");
}

/** A lost confirm is applying server-side: resume it instead of previewing again. */
function applyingResumeError(account: BillingAccountPlan): PiPodError {
  const quoteId = account.openPlanChange?.quoteId;
  return new PiPodError(
    quoteId
      ? `a plan change is already being applied (quote ${quoteId}); resume it instead of starting a new preview`
      : "a plan change is already being applied; resume it instead of starting a new preview",
    {
      hint: quoteId
        ? `retry the same quote even if it expired: \`pipod billing change confirm --quote ${quoteId}\``
        : "re-read the account and confirm the open quote id",
      code: "open_plan_change_applying",
    },
  );
}

function cannotChangeError(account: BillingAccountPlan): PiPodError {
  const reasons: string[] = [];
  if (account.status === "trialing") reasons.push("trial subscriptions cannot change plans");
  if (account.pendingPlanKey) reasons.push(`a change to ${account.pendingPlanKey} is already pending`);
  if (account.cancelAtPeriodEnd) reasons.push("the subscription is set to cancel at period end");
  return new PiPodError(
    reasons.length > 0
      ? `this subscription cannot change plans: ${reasons.join("; ")}`
      : "this subscription cannot change plans (an active paid subscription is required)",
    { hint: "manage the subscription in the billing portal: `pipod billing portal`" },
  );
}

/**
 * True while the account holds an applying open quote: the only state that
 * resumes. Reads the explicit `canResumePlanChange` flag when the server sends
 * it, falling back to `openPlanChange.state === "applying"` (CONTRACT-NOTES.md).
 */
function canResumeAccount(account: BillingAccountPlan): boolean {
  if (account.canResumePlanChange === true) return true;
  return account.openPlanChange?.state === "applying";
}

/**
 * The gate for minting a fresh preview: static backends have no `/v1/billing`
 * (null account) and the surface stays omitted; otherwise only `canChangePlan`
 * proceeds. When `canChangePlan` is false because the open quote is `applying`
 * (or `canResumePlanChange` is true), the caller must resume the SAME quote id
 * — never preview again.
 */
async function requireChangeableAccount(client: AccountClient): Promise<BillingAccountPlan> {
  const account = await client.billingAccountPlan();
  if (!account) {
    info("plan changes are not available on this server (self-hosted installs have no plans to change)");
    throw new PlanChangeOmitted();
  }
  if (!account.canChangePlan) {
    if (canResumeAccount(account)) throw applyingResumeError(account);
    throw cannotChangeError(account);
  }
  return account;
}

/**
 * The gate for `confirm --quote`: a lost confirm resumes the same quote even
 * when `canChangePlan` is now false and even when `expiresAt` passed. Only a
 * non-applying refusal still blocks.
 */
async function requireConfirmableAccount(client: AccountClient): Promise<BillingAccountPlan> {
  const account = await client.billingAccountPlan();
  if (!account) {
    info("plan changes are not available on this server (self-hosted installs have no plans to change)");
    throw new PlanChangeOmitted();
  }
  if (!account.canChangePlan && !canResumeAccount(account)) {
    throw cannotChangeError(account);
  }
  return account;
}

/** Control flow: the surface is omitted, which is a clean exit, not a failure. */
class PlanChangeOmitted extends Error {}

/**
 * Friendly copy for the quote/confirm refusals; the server `code` stays on the
 * error. 402 `card_declined`/`authentication_required` means the quote FAILED:
 * new preview after the portal, never a replay of the failed key. 5xx and
 * timeouts are unknown: the quote stays `applying`, so retry the SAME quote
 * id even if `expiresAt` passed. 409 `plan_change_effect_unknown` is UNKNOWN
 * possible paid effect (not `quote_stale`): keep the SAME quote id, never
 * clear it, mint a new preview, or require new consent. No payment URL is
 * ever printed or hinted here.
 */
function planChangeRefusal(error: unknown, quoteId: string | null, currentPlan: string | null): PiPodError {
  if (!(error instanceof PiPodError)) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|timed out|abort|fetch failed|network|ECONN|EAI_AGAIN|socket hang up|not get a clear/i.test(message)) {
      return new PiPodError(
        "the plan change result is unconfirmed and may already have applied; retry the same quote to learn the outcome",
        {
          hint: quoteId
            ? `the quote stays applying — retry the same quote even if it expired: \`pipod billing change confirm --quote ${quoteId}\``
            : "re-read the account and confirm the open quote id",
          code: "confirm_unknown",
          transient: true,
        },
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
  switch (error.code) {
    case "plan_change_in_flight": {
      // While applying, preview answers 409 with `{ quoteId, state }`: resume
      // that id instead of minting a fresh preview. Confirm collisions carry
      // the same id the caller just sent — retry it even if it expired.
      const resumeId = resumeQuoteId(error.detail, quoteId);
      return new PiPodError(
        resumeId
          ? `a plan change is already being applied (quote ${resumeId}); resume it instead of starting a new preview`
          : "a plan change is already being applied; resume it instead of starting a new preview",
        {
          hint: resumeId
            ? `retry the same quote even if it expired: \`pipod billing change confirm --quote ${resumeId}\``
            : "re-read the account and confirm the open quote id",
          code: error.code,
          status: error.status,
        },
      );
    }
    case "plan_change_effect_unknown": {
      // UNKNOWN possible paid effect — not `quote_stale`. Keep the SAME quote
      // id (detail.quoteId or in-hand) and retry even if it expired or
      // `canChangePlan` is now false. Never clear, preview again, or require
      // new consent. No payment URL is ever printed here.
      const retryId = resumeQuoteId(error.detail, quoteId);
      return new PiPodError(
        "the plan change effect is unknown and may already have applied; the result is unconfirmed — retry the same quote to learn the outcome",
        {
          hint: retryId
            ? `the effect is unknown — retry the same quote even if it expired: \`pipod billing change confirm --quote ${retryId}\``
            : "re-read the account and confirm the open quote id",
          code: error.code,
          status: error.status,
          transient: true,
        },
      );
    }
    case "quote_stale":
    case "quote_expired":
      return new PiPodError(
        "the quote changed or expired since the preview; nothing was confirmed and nothing was charged",
        { hint: "preview again and confirm the new quote", code: error.code, status: error.status },
      );
    case "cap_below_new_base":
      return new PiPodError(
        "the spend cap is below the new plan's base price, so the change was refused and the cap was left alone",
        { hint: "raise the spend cap first, then preview again (the client never raises it for you)", code: error.code, status: error.status },
      );
    case "trial_plan_change_unavailable":
      return new PiPodError("trial subscriptions cannot change plans", {
        hint: "manage the subscription in the billing portal: `pipod billing portal`",
        code: error.code,
        status: error.status,
      });
    case "card_declined":
    case "authentication_required":
      return new PiPodError(
        currentPlan
          ? `payment ${error.code === "card_declined" ? "was declined" : "needs authentication"}; the quote failed with no pending invoice and the plan did not change (still ${currentPlan}) — Pro was not granted`
          : `payment ${error.code === "card_declined" ? "was declined" : "needs authentication"}; the quote failed with no pending invoice and the plan did not change — Pro was not granted`,
        {
          // Failed quotes are never replayed: fix the card in the portal, then
          // mint a fresh preview. No payment URL is ever printed here.
          hint: "fix the card in the portal (`pipod billing portal`), then preview again — do not retry the failed quote",
          code: error.code,
          status: error.status,
        },
      );
    case "plan_change_not_applied":
      return new PiPodError(
        currentPlan
          ? `the plan change was not applied; the plan did not change (still ${currentPlan}) and Pro was not granted`
          : "the plan change was not applied; the plan did not change and Pro was not granted",
        {
          hint: "preview again and confirm the new quote",
          code: error.code,
          status: error.status,
        },
      );
    default:
      if (error.status === 402) {
        return new PiPodError(
          currentPlan
            ? `payment failed; the quote failed with no pending invoice and the plan did not change (still ${currentPlan}) — Pro was not granted`
            : "payment failed; the quote failed with no pending invoice and the plan did not change — Pro was not granted",
          {
            // Any 402 is a failed quote: portal, then a new preview. Never
            // replay the failed key. No payment URL is ever printed here.
            hint: "fix the card in the portal (`pipod billing portal`), then preview again — do not retry the failed quote",
            code: error.code,
            status: error.status,
          },
        );
      }
      if (error.status === 404) {
        return new PiPodError("plan changes are not available on this server", {
          hint: "self-hosted installs have no plans to change",
          status: error.status,
        });
      }
      if (error.transient || (error.status !== undefined && error.status >= 500)) {
        return new PiPodError(
          "the plan change result is unconfirmed — the quote stays applying and may already have applied; retry the same quote to learn the outcome",
          {
            hint: quoteId
              ? `retry the same quote even if it expired: \`pipod billing change confirm --quote ${quoteId}\``
              : "re-read the account and confirm the open quote id",
            code: error.code,
            status: error.status,
            transient: true,
          },
        );
      }
      return error;
  }
}

/** Resume id from a `plan_change_in_flight` detail, falling back to the in-hand id. */
function resumeQuoteId(detail: unknown, fallback: string | null): string | null {
  if (detail !== null && typeof detail === "object" && !Array.isArray(detail)) {
    const raw = (detail as Record<string, unknown>)["quoteId"];
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length > 0 && trimmed.length <= 64 && !/[\u0000-\u001f\u007f\s]/.test(trimmed)) {
        return trimmed;
      }
    }
  }
  return fallback;
}

/**
 * A confirm 200 is `{ applied, ...quote, account }`: success is `applied === true`
 * AND the returned account showing the target — `planKey` for an immediate
 * change, `pendingPlanKey` for a period-end downgrade. Either signal alone
 * grants nothing: `applied:true` leaving the old plan, or the target plan
 * without `applied:true`, is `plan_change_not_applied` (retry the same id:
 * it stays applying). A missing `applied` is never success.
 */
function requireAppliedGrant(
  applied: boolean,
  account: BillingAccountPlan | null,
  target: BillingPlanKey,
  currentPlan: string | null,
): void {
  if (applied === true && (account?.planKey === target || account?.pendingPlanKey === target)) return;
  throw new PiPodError(
    currentPlan
      ? `the plan change was not applied; the plan did not change (still ${currentPlan}) and Pro was not granted`
      : "the plan change was not applied; the plan did not change and Pro was not granted",
    { hint: "preview again and confirm the new quote", code: "plan_change_not_applied" },
  );
}

async function askYes(deps: BillingCommandDeps, question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (deps.ask) return deps.ask(question);
  return confirm(question, { nonInteractiveDefault: false });
}

/** The outcome is read off a freshly fetched account — never off the quote echo. */
async function printChangeResult(client: AccountClient, target: BillingPlanKey): Promise<void> {
  let account: BillingAccountPlan | null = null;
  try {
    account = await client.billingAccountPlan();
  } catch {
    account = null;
  }
  if (!account) {
    info(`plan change confirmed for ${target}; the account could not be re-read — check the portal`);
    return;
  }
  printAccountContext(account);
  if (account.pendingPlanKey) {
    info(`plan change recorded: ${account.pendingPlanKey} takes effect at the end of the current period`);
  } else if (account.planKey) {
    info(`current plan: ${account.planKey}`);
  } else {
    info(`plan change confirmed for ${target}`);
  }
}

async function runPlanChange(client: AccountClient, args: string[], deps: BillingCommandDeps): Promise<number> {
  const form = parseChangeArgs(args);
  if (form.kind === "confirm") return runPlanChangeConfirm(client, form.quoteId, form.yes, deps);

  let account: BillingAccountPlan;
  try {
    account = await requireChangeableAccount(client);
  } catch (error) {
    if (error instanceof PlanChangeOmitted) return EXIT.OK;
    throw error;
  }
  let quote: PlanChangeQuoteView;
  try {
    quote = await client.previewPlanChange(form.plan);
  } catch (error) {
    throw planChangeRefusal(error, null, null);
  }
  printAccountContext(account);
  printQuote(quote, account);
  if (form.kind === "preview") {
    info(`to confirm this quote: \`pipod billing change confirm --quote ${quote.quoteId}\``);
    return EXIT.OK;
  }
  const question =
    quote.timing === "immediate"
      ? `Change ${quote.currentPlan} → ${quote.targetPlan} now, ${money(quote.amountDueNowCents, quote.currency)} ${quote.currency.toUpperCase()} due now?`
      : `Change ${quote.currentPlan} → ${quote.targetPlan} at period end?`;
  if (!(await askYes(deps, question, form.yes))) {
    info("not confirmed — nothing was changed");
    return EXIT.OK;
  }
  // The confirm body is the quote id only — never a caller-selected plan — and a
  // stale/expired quote is never auto-confirmed: a 409 means preview again.
  // The 200 body is `{ applied, ...quote, account }`: success is `applied === true`
  // AND the returned account showing the target (planKey, or pendingPlanKey for a
  // period-end downgrade). A missing `applied` never grants Pro.
  try {
    const result = await client.confirmPlanChange(quote.quoteId);
    requireAppliedGrant(result.applied, result.account, quote.targetPlan, quote.currentPlan);
  } catch (error) {
    throw planChangeRefusal(error, quote.quoteId, quote.currentPlan);
  }
  await printChangeResult(client, quote.targetPlan);
  return EXIT.OK;
}

async function runPlanChangeConfirm(client: AccountClient, quoteId: string, yes: boolean, deps: BillingCommandDeps): Promise<number> {
  // Restart recovery reads the account first but never mints a fresh quote:
  // an applying open quote resumes here even when `canChangePlan` is false
  // and even when `expiresAt` passed.
  let resumeAccount: BillingAccountPlan | null = null;
  try {
    resumeAccount = await requireConfirmableAccount(client);
  } catch (error) {
    if (error instanceof PlanChangeOmitted) return EXIT.OK;
    throw error;
  }
  const resumePlan = resumeAccount.planKey ?? null;
  // Blind by design: no endpoint replays a quote's amounts, so the yes below
  // re-affirms the preview just approved. Overcharge is still impossible by
  // accident — the server re-previews on confirm and refuses drift as 409.
  if (!(await askYes(deps, `Confirm the previewed plan change for quote ${quoteId}? Answer yes only for the preview you just approved.`, yes))) {
    info("not confirmed — nothing was changed");
    return EXIT.OK;
  }
  let target: BillingPlanKey;
  try {
    const result = await client.confirmPlanChange(quoteId);
    requireAppliedGrant(result.applied, result.account, result.quote.targetPlan, result.quote.currentPlan ?? resumePlan);
    target = result.quote.targetPlan;
  } catch (error) {
    throw planChangeRefusal(error, quoteId, resumePlan);
  }
  await printChangeResult(client, target);
  return EXIT.OK;
}
