/**
 * src/account/billing.ts — the SaaS workstation/usage surface, and the edition boundary that hides it.
 *
 * pi pod ships in two editions from one codebase. The self-hosted edition runs the sandbox
 * runtime next to the server on hardware the operator already pays for: it has no plan, no
 * metered active hours and no spend cap, so the server omits the `workstation` block entirely.
 * The SaaS edition (`SANDBOX_HOST_BACKEND=boat`) meters a personal workstation per user and
 * sends a flat `workstation` block on `GET /v1/me`.
 *
 * The client's whole half of that boundary is this rule: **when the block is absent, the
 * surface disappears silently.** Not a zero, not "unknown", not an empty heading — nothing.
 * A self-hosted operator must never see a spend cap they do not have, and must never be
 * asked to explain one to their users.
 *
 * The wire shape is the server's `workstationSummary()` (src/server/billing/routes.ts): flat
 * keys, no nesting. Every field here is independently optional and independently validated.
 * A partial block renders its parts; a malformed field is treated as absent rather than as a
 * value; and no number is ever computed, projected or priced by the client. "12.4 of 60 active
 * hours" is allowed because the server sent both numbers. "48 hours left, about $12 more" is not.
 */

/** Bounded so a hostile or buggy value cannot become an unbounded terminal line. */
const MAX_LABEL_LENGTH = 64;

/** The account's billing state inside the `workstation` block (`BillingStatus` server-side). */
export type BillingStatus = "none" | "trialing" | "active" | "past_due" | "canceled";

/** How close the account is to its cap; informational only, never recomputed here. */
export type SpendCapState = "ok" | "warning" | "reached";

/** Why a machine start is refused (`StartBlockedReason` server-side). */
export type StartBlockedReason =
  | "subscription_required" | "trial_expired" | "trial_hours_exhausted"
  | "payment_past_due" | "spend_cap_reached" | "billing_meter_history_unknown";

const BILLING_STATUSES: ReadonlySet<string> = new Set(["none", "trialing", "active", "past_due", "canceled"]);
const SPEND_CAP_STATES: ReadonlySet<string> = new Set(["ok", "warning", "reached"]);
const START_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  "subscription_required", "trial_expired", "trial_hours_exhausted",
  "payment_past_due", "spend_cap_reached", "billing_meter_history_unknown",
]);
const METERING_HOLDS: ReadonlySet<string> = new Set([
  "payment_past_due", "spend_cap_reached", "billing_meter_history_unknown",
]);

/**
 * The flat `workstation` block, field for field. Unknown keys are dropped and unknown enum
 * values are ignored while the numbers beside them are kept — a server that grows a state the
 * client does not know still renders the hours and the cap it does.
 */
export interface AccountBilling {
  planKey?: string;
  planName?: string;
  status?: BillingStatus;
  /** Wall-clock diagnostic (may include unvouched time). Prefer billable seconds for allowance. */
  activeHoursUsed?: number;
  includedActiveHours?: number;
  overageHours?: number;
  overageUsdCentsPerHour?: number;
  spendCapUsdCents?: number;
  projectedSpendUsdCents?: number;
  uncappedSpendUsdCents?: number;
  spendCapState?: SpendCapState;
  startsBlocked?: boolean;
  startBlockedReason?: StartBlockedReason;
  parallelSandboxes?: number;
  workspaceStorageGb?: number;
  currentPeriodEnd?: string;
  trialEndsAt?: string;
  /** Vendor-vouched seconds. Unit change to hours for display only. */
  billableActiveSeconds?: number;
  /** Unvouched/UNKNOWN seconds. Shown separately, never added into confirmed hours. */
  unknownActiveSeconds?: number;
  /** Server-owned hold. Null money remains unknown; the client never prices it. */
  meteringHold?: "payment_past_due" | "spend_cap_reached" | "billing_meter_history_unknown";
  committedOverageUsdCents?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/** A number worth showing: finite and non-negative. Overage above an allowance is expected. */
function amount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) return undefined;
  // Rendered as data on a terminal line: control characters are not data, and a plan name
  // is never a reason to move the cursor.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function instant(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function member(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function defined<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

/**
 * Parse the optional flat `workstation` block (already unwrapped from `/v1/me`). Returns null
 * when the server sent nothing, sent something unusable, or sent an object with no field this
 * client can render — all three of which mean exactly the same thing to the user: there is no
 * plan surface here.
 */
export function parseAccountBilling(value: unknown): AccountBilling | null {
  const root = record(value);
  if (!root) return null;

  const billing: AccountBilling = {};

  const planKey = label(root["planKey"]);
  const planName = label(root["planName"]);
  if (planKey !== undefined) billing.planKey = planKey;
  if (planName !== undefined) billing.planName = planName;

  const status = member(root["status"], BILLING_STATUSES) as BillingStatus | undefined;
  if (status !== undefined) billing.status = status;

  const numbers: Array<[keyof AccountBilling, string]> = [
    ["activeHoursUsed", "activeHoursUsed"],
    ["includedActiveHours", "includedActiveHours"],
    ["overageHours", "overageHours"],
    ["overageUsdCentsPerHour", "overageUsdCentsPerHour"],
    ["spendCapUsdCents", "spendCapUsdCents"],
    ["projectedSpendUsdCents", "projectedSpendUsdCents"],
    ["uncappedSpendUsdCents", "uncappedSpendUsdCents"],
    ["parallelSandboxes", "parallelSandboxes"],
    ["workspaceStorageGb", "workspaceStorageGb"],
    ["billableActiveSeconds", "billableActiveSeconds"],
    ["unknownActiveSeconds", "unknownActiveSeconds"],
    ["committedOverageUsdCents", "committedOverageUsdCents"],
  ];
  const target = billing as Record<string, unknown>;
  for (const [field, key] of numbers) {
    const kept = amount(root[key]);
    if (kept !== undefined) target[field] = kept;
  }

  const spendCapState = member(root["spendCapState"], SPEND_CAP_STATES) as SpendCapState | undefined;
  if (spendCapState !== undefined) billing.spendCapState = spendCapState;

  const startBlockedReason = member(root["startBlockedReason"], START_BLOCKED_REASONS) as StartBlockedReason | undefined;
  if (startBlockedReason !== undefined) billing.startBlockedReason = startBlockedReason;

  const startsBlocked = root["startsBlocked"];
  if (typeof startsBlocked === "boolean") billing.startsBlocked = startsBlocked;

  const currentPeriodEnd = instant(root["currentPeriodEnd"]);
  if (currentPeriodEnd !== undefined) billing.currentPeriodEnd = currentPeriodEnd;

  const trialEndsAt = instant(root["trialEndsAt"]);
  if (trialEndsAt !== undefined) billing.trialEndsAt = trialEndsAt;
  const meteringHold = member(root["meteringHold"], METERING_HOLDS) as AccountBilling["meteringHold"];
  if (meteringHold !== undefined) billing.meteringHold = meteringHold;

  return defined(billing) ?? null;
}

/** `12.4` — one decimal place, and no trailing `.0` on a whole number. */
function hours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** `$40`, `$32.50` — the server quotes cents; the terminal shows dollars. */
function usd(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function formatUsdCents(cents: number): string {
  return usd(cents);
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The one-line workstation summary for `pipod list`, or null when there is nothing to say.
 * Every segment is omitted independently, so a server that reports only active hours renders
 * only active hours. The trial note appears only while the account is actually trialing.
 */
export function billingSummaryLine(billing: AccountBilling | null): string | null {
  if (!billing) return null;
  const segments: string[] = [];

  if (billing.planName !== undefined) segments.push(billing.planName);
  else if (billing.planKey !== undefined) segments.push(billing.planKey);

  const included = billing.includedActiveHours;
  const billableHours =
    billing.billableActiveSeconds !== undefined ? billing.billableActiveSeconds / 3600 : undefined;
  const unknownHours =
    billing.unknownActiveSeconds !== undefined ? billing.unknownActiveSeconds / 3600 : undefined;
  // Confirmed (billable) hours against the allowance when the server sent seconds.
  // Fall back to the wall diagnostic only on a 17-key envelope that has no coverage fields.
  const confirmed = billableHours !== undefined ? billableHours : billing.activeHoursUsed;
  const confirmedLabel = billableHours !== undefined ? "confirmed hours" : "active hours";
  if (confirmed !== undefined && included !== undefined) {
    segments.push(`${hours(confirmed)} of ${hours(included)} ${confirmedLabel}`);
  } else if (confirmed !== undefined) {
    segments.push(
      billableHours !== undefined
        ? `${hours(confirmed)} confirmed hours used`
        : `${hours(confirmed)} active hours used`,
    );
  } else if (included !== undefined) {
    segments.push(`${hours(included)} active hours included`);
  }
  if (unknownHours !== undefined && unknownHours > 0) {
    segments.push(`unconfirmed ${hours(unknownHours)} h`);
  }

  if (billing.spendCapUsdCents !== undefined) segments.push(`spend cap ${usd(billing.spendCapUsdCents)}`);

  if (billing.currentPeriodEnd !== undefined) segments.push(`period ends ${day(billing.currentPeriodEnd)}`);

  // A trial note is true only while the account is trialing: a leftover `trialEndsAt` on a
  // past_due account is history, not a deadline the user still has.
  if (billing.status === "trialing" && billing.trialEndsAt !== undefined) {
    segments.push(`trial ends ${day(billing.trialEndsAt)}`);
  }

  return segments.length > 0 ? segments.join(" · ") : null;
}

// --- plan-change quotes (M5; M4 server `plan-change.ts` `PlanChangeQuoteView`) ---------

/** The two paid plans a quote can move between. */
export type BillingPlanKey = "standard" | "pro";

/** `immediate` upgrades bill proration now; `period_end` downgrades wait for renewal. */
export type PlanChangeTiming = "immediate" | "period_end";

const BILLING_PLAN_KEYS: ReadonlySet<string> = new Set(["standard", "pro"]);
const PLAN_CHANGE_TIMINGS: ReadonlySet<string> = new Set(["immediate", "period_end"]);
const QUOTE_ITEM_KINDS: ReadonlySet<string> = new Set(["base", "overage"]);

/** One priced line of a quote: the recurring base price and the metered overage price. */
export interface PlanChangeQuoteItem {
  priceId: string;
  kind: "base" | "overage";
}

/**
 * The server's `PlanChangeQuoteView`, field for field — nothing invented. On an
 * immediate upgrade `recurringAmountCents` is the target licensed base (e.g.
 * 5000) and `nextPeriodAmountCents` equals it (never 0, never a free month);
 * on a period-end downgrade `amountDueNowCents` is 0 and `nextPeriodAmountCents`
 * is the `proration_behavior=none` preview. No hosted payment URL field exists
 * on this view (`hostedPaymentUrl|paymentUrl|checkoutUrl|url` must not be read).
 */
export interface PlanChangeQuoteView {
  quoteId: string;
  currentPlan: BillingPlanKey;
  targetPlan: BillingPlanKey;
  timing: PlanChangeTiming;
  amountDueNowCents: number;
  recurringAmountCents: number;
  nextPeriodAmountCents: number;
  currency: string;
  currentPeriodEnd: string | null;
  effectiveAt: string | null;
  expiresAt: string;
  pendingUpdateExpiresAt: string | null;
  pendingInvoiceId: string | null;
  state: string;
  items: PlanChangeQuoteItem[];
}

/**
 * The authoritative resume pointer from `GET /v1/billing/account`: the open
 * quote or null. `quoted|applying` are the open states; when `canChangePlan`
 * is false because the open quote is `applying`, the client resumes the same
 * `quoteId` instead of minting a fresh preview. The server sends the full
 * quote view here; only `quoteId`/`state` (plus an optional `targetPlan`)
 * are read — everything else is ignored and never blocks a resume.
 */
export interface OpenPlanChange {
  quoteId: string;
  state: string;
  targetPlan?: BillingPlanKey | null;
}

/**
 * The narrow slice of `GET /v1/billing/account` the change command reads: the
 * capability flags, the authoritative `openPlanChange` resume pointer, plus the
 * pending/cancel truth it reports back. Every field the server's `accountView`
 * sends under these names; everything else is ignored.
 *
 * `canResumePlanChange` is true when `openPlanChange.state === "applying"` —
 * restart confirms that quoteId even when `canChangePlan` is false.
 */
export interface BillingAccountPlan {
  canChangePlan: boolean;
  canResumePlanChange: boolean;
  openPlanChange: OpenPlanChange | null;
  planKey?: string;
  status?: BillingStatus;
  pendingPlanKey?: string | null;
  pendingScheduleUnreadable: boolean;
  cancelAtPeriodEnd: boolean;
  /** Recurring prices per plan key, a display fallback when a quote omits renewal. */
  planPrices: Array<{ key: string; name?: string; priceUsdCents?: number }>;
}

function cents(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000_00) return undefined;
  return value;
}

function uuidLike(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return undefined;
  return trimmed;
}

function currencyCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(trimmed)) return undefined;
  return trimmed;
}

function nullableInstant(value: unknown): string | null | undefined {
  if (value === null) return null;
  const parsed = instant(value);
  return parsed === undefined ? undefined : parsed;
}

function nullableId(value: unknown): string | null | undefined {
  if (value === null) return null;
  const parsed = uuidLike(value);
  if (parsed !== undefined) return parsed;
  // Non-UUID invoice-style ids (e.g. `in_...`): bounded opaque token, never rendered as a URL.
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return undefined;
  return trimmed;
}

function quoteState(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return undefined;
  if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Minimal resume pointer: the open quote's id plus its `quoted|applying` state.
 * The server sends the full quote view here, so extra keys are ignored and an
 * optional `targetPlan` (or legacy `plan`) is carried when it names a known plan.
 */
function openPlanChange(value: unknown): OpenPlanChange | null {
  if (value === null || value === undefined) return null;
  const root = record(value);
  if (!root) return null;
  const quoteId = uuidLike(root["quoteId"]);
  const state = quoteState(root["state"]);
  if (quoteId === undefined || state === undefined) return null;
  const rawTarget = root["targetPlan"] ?? root["plan"];
  const targetPlan =
    typeof rawTarget === "string" && BILLING_PLAN_KEYS.has(rawTarget)
      ? (rawTarget as BillingPlanKey)
      : null;
  return targetPlan ? { quoteId, state, targetPlan } : { quoteId, state };
}

function quoteItem(value: unknown): PlanChangeQuoteItem | null {
  const root = record(value);
  if (!root) return null;
  const priceId = root["priceId"];
  const kind = root["kind"];
  if (typeof priceId !== "string" || priceId.length === 0 || priceId.length > 128) return null;
  if (typeof kind !== "string" || !QUOTE_ITEM_KINDS.has(kind)) return null;
  return { priceId, kind: kind as "base" | "overage" };
}

/**
 * Validate a `PlanChangeQuoteView` body field by field. Returns null when any
 * field the command prints or sends back is missing or malformed — the caller
 * reports that instead of rendering a half quote.
 */
export function parsePlanChangeQuote(value: unknown): PlanChangeQuoteView | null {
  const root = record(value);
  if (!root) return null;
  const quoteId = uuidLike(root["quoteId"]);
  const currentPlan = member(root["currentPlan"], BILLING_PLAN_KEYS) as BillingPlanKey | undefined;
  const targetPlan = member(root["targetPlan"], BILLING_PLAN_KEYS) as BillingPlanKey | undefined;
  const timing = member(root["timing"], PLAN_CHANGE_TIMINGS) as PlanChangeTiming | undefined;
  const amountDueNowCents = cents(root["amountDueNowCents"]);
  const recurringAmountCents = cents(root["recurringAmountCents"]);
  const nextPeriodAmountCents = cents(root["nextPeriodAmountCents"]);
  const currency = currencyCode(root["currency"]);
  const currentPeriodEnd = nullableInstant(root["currentPeriodEnd"]);
  const effectiveAt = nullableInstant(root["effectiveAt"]);
  const expiresAt = instant(root["expiresAt"]);
  const pendingUpdateExpiresAt = nullableInstant(root["pendingUpdateExpiresAt"] ?? null);
  const pendingInvoiceId = nullableId(root["pendingInvoiceId"] ?? null);
  const state = quoteState(root["state"]);
  const rawItems = root["items"];
  if (
    quoteId === undefined || currentPlan === undefined || targetPlan === undefined ||
    timing === undefined || amountDueNowCents === undefined || recurringAmountCents === undefined ||
    nextPeriodAmountCents === undefined ||
    currency === undefined || currentPeriodEnd === undefined || effectiveAt === undefined ||
    expiresAt === undefined || pendingUpdateExpiresAt === undefined || pendingInvoiceId === undefined ||
    state === undefined || !Array.isArray(rawItems)
  ) {
    return null;
  }
  const items: PlanChangeQuoteItem[] = [];
  for (const entry of rawItems) {
    const item = quoteItem(entry);
    if (!item) return null;
    items.push(item);
  }
  return {
    quoteId, currentPlan, targetPlan, timing, amountDueNowCents, recurringAmountCents,
    nextPeriodAmountCents, currency, currentPeriodEnd, effectiveAt, expiresAt,
    pendingUpdateExpiresAt, pendingInvoiceId, state, items,
  };
}

/**
 * Validate the `GET /v1/billing/account` body down to the fields the change
 * command needs. Unknown keys are ignored; a non-object body is null.
 */
export function parseBillingAccountPlan(value: unknown): BillingAccountPlan | null {
  const root = record(value);
  if (!root) return null;
  const planKey = label(root["planKey"]);
  const status = member(root["status"], BILLING_STATUSES) as BillingStatus | undefined;
  const pending = root["pendingPlanKey"];
  let pendingPlanKey: string | null | undefined;
  if (pending === null) pendingPlanKey = null;
  else if (typeof pending === "string") pendingPlanKey = label(pending) ?? null;
  const planPrices: BillingAccountPlan["planPrices"] = [];
  const rawPlans = root["availablePlans"];
  if (Array.isArray(rawPlans)) {
    for (const entry of rawPlans) {
      const plan = record(entry);
      if (!plan || typeof plan["key"] !== "string") continue;
      const key = plan["key"].trim();
      if (key.length === 0 || key.length > MAX_LABEL_LENGTH) continue;
      const name = label(plan["name"]);
      const price = plan["priceUsdCents"];
      planPrices.push({
        key,
        ...(name !== undefined ? { name } : {}),
        ...(typeof price === "number" && Number.isInteger(price) && price >= 0 ? { priceUsdCents: price } : {}),
      });
    }
  }
  const open = openPlanChange(root["openPlanChange"] ?? null);
  // A malformed openPlanChange is treated as absent (older servers omit it),
  // never as a reason to block or to mint a quote. `open` is null here in both
  // the absent and the malformed case by construction.
  return {
    canChangePlan: root["canChangePlan"] === true,
    canResumePlanChange: root["canResumePlanChange"] === true,
    openPlanChange: open,
    ...(planKey !== undefined ? { planKey } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(pendingPlanKey !== undefined ? { pendingPlanKey } : {}),
    pendingScheduleUnreadable: root["pendingScheduleUnreadable"] === true,
    cancelAtPeriodEnd: root["cancelAtPeriodEnd"] === true,
    planPrices,
  };
}
