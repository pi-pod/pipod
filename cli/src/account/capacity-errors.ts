/**
 * src/account/capacity-errors.ts — actionable presentation for quota/capacity refusals.
 *
 * The server owns admission, placement, and the 20-concurrent policy; this module only
 * translates the refusals the server already sends into copy a person can act on. It keys
 * on stable signals (typed `detail.reason`/`code`, the two concurrency sentences, known
 * fleet capacity sentences) plus an allowlisted future typed detail — never on a bare
 * HTTP status, arbitrary provider error strings, URLs, or secrets. Numbers shown come
 * from validated captures only.
 */

import { PiPodError } from "../errors.js";
import { workstationDemandOf } from "./workstation.js";

export type CapacityErrorKind =
  | "concurrency-user"
  | "concurrency-org"
  | "fleet-capacity"
  | "temporarily-unavailable"
  | "unsupported-shape"
  | "restore-required"
  /** The account's own billing state stopped this: a spend cap, an ended trial, a payment. */
  | "billing-blocked";

export interface ClassifiedCapacityError {
  kind: CapacityErrorKind;
  /** True when retrying shortly (after a slot frees / capacity appears) can succeed. */
  retryable: boolean;
  /** Safe, actionable copy. No provider text, URLs, or secrets. */
  hint: string;
}

/** Product policy: up to 20 concurrent provider-backed sandboxes per platform user. */
export const PRODUCT_CONCURRENCY_POLICY = 20;

/** Standard sandbox shape documented by the cost-control plan (shared vCPU, capped memory/disk). */
export const PRODUCT_STANDARD_SHAPE = "2 shared vCPU / 4 GiB memory / 20 GiB writable disk";

function typedDetail(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof PiPodError) || error.detail === null || typeof error.detail !== "object") return null;
  if (Array.isArray(error.detail)) return null;
  return error.detail as Record<string, unknown>;
}

function detailReason(error: unknown): string | null {
  const detail = typedDetail(error);
  const reason = detail?.["reason"];
  return typeof reason === "string" ? reason : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a launch/wake/restore refusal. Returns null when the error is not a recognized
 * capacity/quota shape — callers then surface the original error unchanged.
 *
 * Deliberately narrow: a bare HTTP status (including 503) without a typed capacity
 * reason/code or a known fleet sentence is NOT fleet pressure — it could be database,
 * auth, or upstream trouble, and claiming "fleet full" would misdirect the operator.
 * Likewise a resource "supports at most … — using …" message describes a CLAMP the server
 * applied, so it must never map to the not-clamped shape refusal.
 */
export function classifyCapacityError(error: unknown): ClassifiedCapacityError | null {
  const message = messageOf(error);
  const reason = detailReason(error);
  const code = error instanceof PiPodError ? error.code : undefined;

  // A personal workstation that is asleep or starting is not capacity pressure and has no
  // fleet to blame: nobody registers a workstation, and telling its owner to ask someone for
  // capacity sends them after a person who does not exist. `account/workstation.ts` owns that
  // path, so it deliberately leaves here unclassified.
  if (workstationDemandOf(error) !== null) return null;

  // Billing refusals are terminal decisions about money, not waits. They must never enter a
  // retry loop and never render as "retry shortly".
  const billing = classifyBillingRefusal(error);
  if (billing !== null) return billing;

  // Future typed contract (tolerated, never required): reason + code survive via
  // PiPodError.detail/code. Unknown reasons fall through to sentence matching below.
  // Reason set: capacity contract §1–2 (memory/cpu/disk/transition/network_capacity,
  // memory_debt, fairness_degraded, fleet_capacity, unsupported_shape).
  if (reason !== null) {
    switch (reason) {
      case "disk_capacity":
      case "memory_capacity":
      case "transition_capacity":
      case "cpu_capacity":
      case "network_capacity":
      case "memory_debt":
      case "fleet_capacity":
      case "fairness_degraded":
        return {
          kind: "fleet-capacity",
          retryable: true,
          hint: capacityReasonHint(reason),
        };
      case "unsupported_shape":
        return {
          kind: "unsupported-shape",
          retryable: false,
          hint: capacityHint("shape"),
        };
      default:
        break;
    }
  }
  // Stable typed error codes name the refusal without message parsing. `admission_denied`
  // is by construction a capacity refusal; anything else falls through to sentences.
  if (code === "admission_denied") {
    return {
      kind: "fleet-capacity",
      retryable: true,
      hint: capacityHint("fleet"),
    };
  }
  if (code === "unsupported_shape") {
    return {
      kind: "unsupported-shape",
      retryable: false,
      hint: capacityHint("shape"),
    };
  }

  if (/restore the pod/i.test(message)) {
    return {
      kind: "restore-required",
      retryable: false,
      hint: "restore the pod first (`pipod restore <pod>`), then retry — attach restarts its sandbox when needed",
    };
  }
  const userCap = /caps concurrent pods per user at (\d+)/i.exec(message);
  if (userCap) {
    const cap = Number(userCap[1]);
    const shown = Number.isFinite(cap) ? ` ${cap}` : "";
    return {
      kind: "concurrency-user",
      retryable: true,
      hint:
        `you are at the concurrent-sandbox limit${shown} (product policy: up to ${PRODUCT_CONCURRENCY_POLICY} per user). ` +
        "Stop a running pod (`pipod stop <pod>`) or wait for idle sleep under your idle policy, then retry",
    };
  }
  const orgCap = /org policy caps concurrent pods at (\d+)/i.exec(message);
  if (orgCap) {
    const cap = Number(orgCap[1]);
    const shown = Number.isFinite(cap) ? ` ${cap}` : "";
    return {
      kind: "concurrency-org",
      retryable: true,
      hint:
        `your organization is at its concurrent-sandbox limit${shown}. ` +
        "Stop a running pod or wait for idle sleep under your idle policy, then retry — or ask an owner to raise the org policy",
    };
  }
  if (
    /fleet is at capacity|no sandbox host .* room for a sandbox|every active sandbox host refused/i.test(message)
  ) {
    return {
      kind: "fleet-capacity",
      retryable: true,
      hint: capacityHint("fleet"),
    };
  }
  if (/pod is temporarily unavailable; retry shortly/i.test(message)) {
    return {
      kind: "temporarily-unavailable",
      retryable: true,
      hint: "the pod is mid-transition (starting, stopping, or restoring) — retry shortly without creating a new pod",
    };
  }
  // A genuine shape refusal names itself unsupported. A "supports at most … — using …"
  // message is the opposite — a clamp the server applied — and must not map here.
  if (/unsupported/i.test(message) && /shape|memory|disk|cpu|8 ?gi?b/i.test(message)) {
    return {
      kind: "unsupported-shape",
      retryable: false,
      hint: capacityHint("shape"),
    };
  }
  return null;
}

/**
 * Billing refusals: a required subscription, an ended trial, an exhausted trial grant, a
 * payment past its grace, and a reached spend cap.
 *
 * These are exactly the five reasons the server's `StartBlockedReason` can name, and the
 * server's own sentence is the anchor — the copy says the same thing, then adds only what to
 * do and the reassurance that nothing was deleted. Every number comes from a validated field
 * the server actually sent in the 402 `detail`; when it sent none the copy still works, it
 * just carries no figure. The client never names a price, a plan or a policy of its own: it
 * does not know them, and a wrong figure about money is worse than no figure.
 */
function classifyBillingRefusal(error: unknown): ClassifiedCapacityError | null {
  const detail = typedDetail(error);
  const reason = detailReason(error) ?? (error instanceof PiPodError ? error.code ?? null : null);
  if (reason === null) return null;
  switch (reason) {
    case "subscription_required":
      return { kind: "billing-blocked", retryable: false, hint: subscriptionHint() };
    case "trial_expired":
      return { kind: "billing-blocked", retryable: false, hint: trialExpiredHint() };
    case "trial_hours_exhausted":
      return { kind: "billing-blocked", retryable: false, hint: trialHoursHint(detail) };
    case "payment_past_due":
      return { kind: "billing-blocked", retryable: false, hint: paymentHint() };
    case "spend_cap_reached":
      return { kind: "billing-blocked", retryable: false, hint: spendCapHint(detail) };
    default:
      return null;
  }
}

/** The one reassurance every refusal may give: a start being blocked is not data loss. */
const RETAINED = "every workspace stays on the workstation's disk in the meantime";

/** A finite, non-negative number the server sent, or null. Nothing here is ever computed. */
function billingAmount(detail: Record<string, unknown> | null, key: string): number | null {
  const value = detail?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function billingDay(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

/** `$40.00` — the server's own spend-cap sentence always quotes cents to two places. */
function capMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** `60`, `12.4` — a whole grant stays whole; a stub grant keeps its one decimal. */
function capHours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function subscriptionHint(): string {
  return "your workstation needs an active subscription before it can start — subscribe to start it again; " + RETAINED;
}

function trialExpiredHint(): string {
  return "your trial has ended, so your workstation will not start again — subscribe to start it again; " + RETAINED;
}

function trialHoursHint(detail: Record<string, unknown> | null): string {
  const included = billingAmount(detail, "includedActiveHours");
  const grant =
    included !== null
      ? `includes ${capHours(included)} active hours and they are used up`
      : "active hours have been used up";
  return `your trial ${grant}, so your workstation will not start again — subscribe to continue; ${RETAINED}`;
}

function paymentHint(): string {
  return (
    "your last payment failed and the grace period has ended, so your workstation cannot start — " +
    `update your payment method to start it again; ${RETAINED}`
  );
}

function spendCapHint(detail: Record<string, unknown> | null): string {
  const cap = billingAmount(detail, "spendCapUsdCents");
  const resets = billingDay(detail, "currentPeriodEnd");
  const reached =
    cap !== null ? `your monthly spend cap of ${capMoney(cap)} is reached` : "your monthly spend cap is reached";
  const until = resets !== null ? ` It resets on ${resets}.` : "";
  return (
    `${reached}, so your workstation will not start again.${until} ` +
    `Raise the cap or wait for the period to reset — ${RETAINED}`
  );
}

function capacityHint(which: "fleet" | "shape"): string {
  if (which === "shape") {
    return (
      "that worker shape is not available on a qualified host (8 GiB is gated opt-in; standard is 4 GiB). " +
      "The request was not silently clamped — retry at the standard shape or wait for qualified capacity"
    );
  }
  return (
    "the fleet has no room for a new sandbox right now. Retry shortly — stopped pods keep their files " +
    "and archived pods restore later, so do not create duplicates. If this persists, ask an owner to register capacity"
  );
}

/**
 * Reason-specific fleet copy (capacity contract §1–2). Falls back to the generic fleet
 * hint for plain resource pressures; degraded-fairness and drain states name themselves
 * so a retry pause reads as temporary rather than broken.
 */
export function capacityReasonHint(reason: string): string {
  switch (reason) {
    case "fairness_degraded":
      return (
        "CPU fairness is temporarily degraded — existing sandboxes keep running; " +
        "retry shortly without creating duplicates"
      );
    case "memory_debt":
      return (
        "hosts are draining pre-upgrade workloads — retry shortly without creating duplicates"
      );
    default:
      return capacityHint("fleet");
  }
}

/** Short resource noun for wait-progress lines; unknown reasons stay generic. */
export function capacityReasonShort(reason: string | null): string {
  switch (reason) {
    case "memory_capacity":
    case "memory_debt":
      return "memory";
    case "disk_capacity":
      return "disk";
    case "cpu_capacity":
      return "CPU";
    case "transition_capacity":
      return "transition";
    case "network_capacity":
      return "network";
    case "fairness_degraded":
      return "fair CPU share";
    case "fleet_capacity":
      return "fleet";
    default:
      return "capacity";
  }
}

/**
 * Terminal wait-state copy. `expired` is FINAL for this wait — but the backend is
 * ambiguous (the server may have admitted late), so no copy may claim nothing was
 * created or tell the user to unconditionally launch again. Every remedy routes
 * through checking THIS pod's status first, with no duplicates. `cancelled` means
 * someone (or pod deletion) ended the wait; only a wake-kind cancel may call the
 * pre-existing workspace untouched, since a create-kind wait may have a backend the
 * client has not observed yet.
 */
export function capacityWaitTerminalHint(
  state: "expired" | "cancelled",
  reason: string | null,
  kind?: string | null,
): string {
  const wake = kind === "wake";
  if (state === "cancelled") {
    return wake
      ? "the capacity wait was cancelled — check the pod's status before retrying; the existing workspace is untouched"
      : "cancellation requested — check this pod's status before retrying; do not assume no backend was created and do not duplicate the row";
  }
  const what = reason !== null ? `no room for ${capacityReasonShort(reason)}` : "no room";
  return wake
    ? `${what} before the capacity deadline — this wait is over; check the pod's status, then restore or retry this pod — do not create duplicates or launch a new pod`
    : `${what} before the capacity deadline — this wait is over and nothing was admitted in time; check this pod's status first (it may have been admitted late), then retry — do not launch a duplicate`;
}

/**
 * Attach the actionable hint to a capacity/quota refusal, preserving status/code/transient
 * EXACTLY so transport retry behavior never changes. This wrapper is presentation-only:
 * `retryable` messaging lives in the hint text, never in the transport retry flag —
 * promoting a 409 quota refusal to transient would send the launch blip-recovery path into
 * a 90-second reconnect loop and could duplicate operations. Non-capacity errors pass
 * through untouched.
 */
export function withCapacityHint(error: unknown): unknown {
  const classified = classifyCapacityError(error);
  if (!classified || !(error instanceof PiPodError)) return error;
  if (error.hint?.includes(classified.hint)) return error;
  const hint = error.hint ? `${error.hint}\n${classified.hint}` : classified.hint;
  return new PiPodError(error.message, {
    hint,
    exitCode: error.exitCode,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.code !== undefined ? { code: error.code } : {}),
    transient: error.transient,
    ...(error.detail !== undefined ? { detail: error.detail } : {}),
    cause: error,
  });
}

/**
 * One-line summary for launch/wake failure footers. Null when there is nothing
 * capacity-specific to add — callers keep the original message alone.
 */
export function capacityFailureSummary(error: unknown): string | null {
  const classified = classifyCapacityError(error);
  if (!classified) return null;
  switch (classified.kind) {
    case "concurrency-user":
      return `at the per-user concurrent-sandbox limit (policy: ${PRODUCT_CONCURRENCY_POLICY}); free a slot and retry`;
    case "concurrency-org":
      return "at the organization concurrent-sandbox limit; free a slot and retry";
    case "fleet-capacity":
      return "fleet at capacity; retry shortly without duplicating the request";
    case "temporarily-unavailable":
      return "pod mid-transition; retry shortly";
    case "unsupported-shape":
      return "shape unavailable on qualified hosts; not clamped — retry at standard size";
    case "restore-required":
      return "restore the pod first, then retry";
    case "billing-blocked":
      return "blocked by this account's billing state; retrying will not change it";
  }
}
