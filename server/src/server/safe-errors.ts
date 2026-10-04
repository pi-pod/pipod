import {
  HttpError,
  isLaunchAdmissionHeldError,
  LAUNCH_ADMISSION_HELD_CODE,
} from "./httperrors.js";

/**
 * src/server/safe-errors.ts — the Phase 4 fail-closed leakage boundary for errors.
 *
 * Fail-closed rule: unexpected provider and unknown throws NEVER emit arbitrary
 * messages, stacks, names, string codes, causes, configs, bodies, or headers.
 * Only three things cross into logs, pod `state_reason` / `resolved_config.warnings`
 * rows (returned to the org's clients), and push bodies (leave the device perimeter):
 *
 * 1. A caller-supplied static prefix (e.g. "launch custody setup failed") — trusted
 *    because it is a string literal at the call site, never derived from the throw.
 * 2. An allowlisted transport identifier or numeric code — an integer HTTP status
 *    100–599, a 3-digit numeric-code string in the same range, or one of the fixed
 *    Node transport codes below. Anything else (including a random opaque string)
 *    is dropped. Capacity (507) is actionable, so it keeps its own capacity wording.
 * 3. A generic bounded message — a fixed string, never interpolated from the throw.
 * 4. A message composed of a static string literal plus the allowlisted enums and
 *    finite numbers that `sanitizeErrorDetails` validated out of a host `details`
 *    object (`renderAdmissionRefusal` / `describeAdmissionRefusal`). The host's own
 *    message, hint, and body are still dropped; an unrecognized or malformed
 *    `details` renders nothing and the caller falls back to (3).
 *
 * There is deliberately NO regex masking of credential shapes here. Masking cannot
 * find a value it never saw (a random opaque secret has no known prefix), so any
 * boundary that returns substrings of the throw leaks by construction. The old
 * pattern list is removed for that reason.
 *
 * Narrowly retained safe paths: HttpError with status < 500 stays in app.ts as a
 * client-visible 4xx (the same caller already sent the input), and one private-
 * factory-issued held-launch 503 returns fixed copy plus a freshly built allowlisted
 * detail. Neither path uses arbitrary text. Every other sink stays generic. Stacks
 * are never emitted — a stack always re-embeds the message.
 */

/** Upper bound for any error string that crosses into logs, rows, or pushes. */
export const MAX_ERROR_MESSAGE_CHARS = 500;

/** Generic bounded messages. Fixed strings only — never interpolate a throw. */
export const GENERIC_OPERATION_FAILED = "operation failed";
const GENERIC_PROVIDER_FAILED = "provider request failed";
const GENERIC_CAPACITY_FAILED = "sandbox hosts at capacity";

export interface LaunchAdmissionHeldDetail {
  code: typeof LAUNCH_ADMISSION_HELD_CODE;
  retryable: true;
}

/**
 * Recognize only the private factory-issued held-gate error and return a fresh,
 * exact detail object. Descriptors avoid invoking mutable accessors; every proxy
 * or malformed shape fails closed to the generic 500 boundary.
 */
export function launchAdmissionHeldDetail(error: unknown): LaunchAdmissionHeldDetail | null {
  if (!isLaunchAdmissionHeldError(error)) return null;
  try {
    const status = Object.getOwnPropertyDescriptor(error, "statusCode");
    if (!status || !("value" in status) || status.value !== 503) return null;
    const detailProperty = Object.getOwnPropertyDescriptor(error, "detail");
    if (!detailProperty || !("value" in detailProperty)) return null;
    const detail = detailProperty.value;
    if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return null;
    const keys = Reflect.ownKeys(detail);
    if (keys.length !== 2 || !keys.includes("code") || !keys.includes("retryable")) return null;
    const code = Object.getOwnPropertyDescriptor(detail, "code");
    const retryable = Object.getOwnPropertyDescriptor(detail, "retryable");
    if (!code || !("value" in code) || code.value !== LAUNCH_ADMISSION_HELD_CODE) return null;
    if (!retryable || !("value" in retryable) || retryable.value !== true) return null;
    return { code: LAUNCH_ADMISSION_HELD_CODE, retryable: true };
  } catch {
    return null;
  }
}

/**
 * Fixed allowlist of Node transport identifiers. Bounded, transport-level, never
 * secret-bearing. Exact match only — any other string code is dropped.
 */
const ALLOWLISTED_TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
]);

function isHttpStatusCodeNumber(code: unknown): code is number {
  return (
    typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599
  );
}

/** A 3-digit numeric-code string ("507") in HTTP range. Exact digits only. */
function isHttpStatusCodeString(code: unknown): code is string {
  if (typeof code !== "string" || code.length !== 3) return false;
  const n = Number(code);
  return Number.isInteger(n) && n >= 100 && n <= 599 && String(n) === code;
}

function allowlistedCodeToken(code: unknown): string | null {
  if (isHttpStatusCodeNumber(code)) return String(code);
  if (isHttpStatusCodeString(code)) return code;
  if (typeof code === "string" && ALLOWLISTED_TRANSPORT_CODES.has(code)) return code;
  return null;
}

/**
 * First allowlisted transport token found on the throw, checking the conventional
 * fields SDKs use. Arbitrary strings, objects, and out-of-range numbers are dropped.
 */
function extractAllowlistedCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const record = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  for (const candidate of [record.code, record.status, record.statusCode]) {
    const token = allowlistedCodeToken(candidate);
    if (token !== null) return token;
  }
  return null;
}

/**
 * Strip control characters and collapse whitespace; bound the length. Safe
 * hygiene only: callers must pass text composed of static copy plus validated
 * enums/numbers — never provider prose or request bodies.
 */
export function boundStaticText(text: string, max: number): string {
  const oneLine = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length > max) return `${oneLine.slice(0, max - 1)}…`;
  return oneLine;
}

/**
 * String-only input has unknown provenance — it may already mix a safe prefix with
 * an arbitrary provider message — so fail-closed means never returning substrings
 * of it. Kept for caller compatibility (provision-failure passes a composed string);
 * always answers the generic message.
 */
export function sanitizeErrorMessage(_message: string, _max = MAX_ERROR_MESSAGE_CHARS): string {
  return GENERIC_OPERATION_FAILED;
}

/**
 * Failure paths: keep the caller's static prefix (trusted literal, bounded) plus a
 * generic suffix and, when present, one allowlisted transport token. The throw's
 * message, stack, name, cause, and body are never read.
 */
export function sanitizeFailureMessage(
  error: unknown,
  opts: { prefix?: string; max?: number } = {},
): string {
  const cleanPrefix =
    typeof opts.prefix === "string" && opts.prefix.trim()
      ? boundStaticText(opts.prefix, 200)
      : "";
  const code = extractAllowlistedCode(error);
  const suffix = code ? `${GENERIC_OPERATION_FAILED} (${code})` : GENERIC_OPERATION_FAILED;
  if (!cleanPrefix) return suffix;
  const combined = `${cleanPrefix}: ${suffix}`;
  const max = typeof opts.max === "number" ? opts.max : MAX_ERROR_MESSAGE_CHARS;
  return combined.length > max ? `${combined.slice(0, max - 1)}…` : combined;
}

/**
 * Validated host error detail that is safe to keep through this boundary.
 *
 * The native contract guarantees `details` carries only enums and finite
 * non-negative numbers (no paths, URLs, env, or tokens), but the server never
 * trusts the wire blindly: unknown kinds/reasons, non-finite or negative numbers,
 * and an out-of-range `retryAfterMs` are dropped, and the whole object is dropped
 * when its discriminator is unrecognized. Returns a fresh copy, never the input.
 */
export function sanitizeErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const details = (error as { details?: unknown }).details;
  if (details === null || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  if (record["kind"] === "admission") return sanitizeAdmissionDetails(record);
  if (record["kind"] === "revision") return sanitizeRevisionDetails(record);
  if (record["kind"] === "operation") return sanitizeOperationDetails(record);
  return undefined;
}

const ADMISSION_REASONS = new Set([
  "memory_capacity",
  "cpu_capacity",
  "disk_capacity",
  "transition_capacity",
  "network_capacity",
  "memory_debt",
  "fairness_degraded",
  "unsupported_shape",
]);

const ADMISSION_RESOURCES = new Set([
  "memory",
  "cpu",
  "disk",
  "network",
  "transitions",
  "shape",
  "fairness",
]);
const ADMISSION_UNITS = new Set(["bytes", "cores", "count", "gb"]);

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  if (record[key] === undefined) return undefined;
  return finiteNonNegative(record[key]);
}

/** A validated resource shape: finite non-negative numbers only, no host text. */
function sanitizedShape(value: unknown, partial: boolean): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["cpu", "memoryGB", "diskGB"]) {
    const field = record[key];
    if (field === undefined) {
      if (!partial) return undefined;
      continue;
    }
    const numeric = finiteNonNegative(field);
    if (numeric === undefined) return undefined;
    out[key] = numeric;
  }
  return out;
}

function sanitizeAdmissionDetails(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ADMISSION_REASONS.has(record["reason"] as string)) return undefined;
  if (!ADMISSION_RESOURCES.has(record["resource"] as string)) return undefined;
  if (!ADMISSION_UNITS.has(record["unit"] as string)) return undefined;
  if (typeof record["retryable"] !== "boolean") return undefined;
  const out: Record<string, unknown> = {
    kind: "admission",
    reason: record["reason"],
    resource: record["resource"],
    unit: record["unit"],
    retryable: record["retryable"],
  };
  for (const key of ["required", "available", "budget", "committed"]) {
    const value = optionalNumber(record, key);
    if (value !== undefined) out[key] = value;
  }
  const retryAfterMs = optionalNumber(record, "retryAfterMs");
  // Bounded hint per contract; absent when the condition is not expected to clear.
  if (retryAfterMs !== undefined && retryAfterMs <= 300_000) out["retryAfterMs"] = retryAfterMs;
  // unsupported_shape only: what was asked vs what the host supports (numbers only).
  if (record["reason"] === "unsupported_shape") {
    const requested = sanitizedShape(record["requested"], true);
    const maximum = sanitizedShape(record["maximum"], false);
    if (requested !== undefined) out["requested"] = requested;
    if (maximum !== undefined) out["maximum"] = maximum;
  }
  return out;
}

function sanitizeRevisionDetails(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const expected = finiteNonNegative(record["expected"]);
  const actual = finiteNonNegative(record["actual"]);
  if (expected === undefined || actual === undefined) return undefined;
  return { kind: "revision", expected, actual };
}

const OPERATION_STATUSES = new Set(["pending", "succeeded", "failed", "cancelled"]);

/** Operation keys name journal rows and log lines: length and charset enforced. */
const OPERATION_KEY_RULE = /^[A-Za-z0-9._:-]{8,128}$/;

function sanitizeOperationDetails(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof record["operationKey"] !== "string" || !OPERATION_KEY_RULE.test(record["operationKey"])) {
    return undefined;
  }
  if (!OPERATION_STATUSES.has(record["status"] as string)) return undefined;
  if (record["sandboxId"] !== null) {
    if (typeof record["sandboxId"] !== "string" || record["sandboxId"].length > 256) return undefined;
  }
  return {
    kind: "operation",
    operationKey: record["operationKey"],
    status: record["status"],
    sandboxId: record["sandboxId"],
  };
}

/**
 * Render a user message from already-sanitized detail (validated numbers/enums),
 * never from the host's free-form message. Returns null when there is no safe
 * detail to render, and callers fall back to the generic provider message.
 */
export function renderAdmissionMessage(details: unknown): string | null {
  if (details === null || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  if (record["kind"] !== "admission") return null;
  if (!ADMISSION_REASONS.has(record["reason"] as string)) return null;
  const reason = record["reason"] as string;
  if (reason === "unsupported_shape") {
    return "this sandbox size is not supported on the available hosts";
  }
  if (reason === "memory_debt") {
    return "sandbox hosts are still draining pre-upgrade workloads; retry shortly";
  }
  if (reason === "fairness_degraded") {
    return "sandbox CPU fairness is temporarily degraded; retry shortly";
  }
  return `sandbox hosts at capacity (${reason})`;
}

/** Bytes per GiB — the unit hosts state byte budgets in, and how we render them. */
const BYTES_PER_GIB = 1024 ** 3;
/**
 * Widest rendered amount that may enter a message. The validated numbers are
 * finite and non-negative but not bounded in magnitude, so a nonsensical 1e300
 * would otherwise eat the whole message budget: anything wider is dropped and
 * the clause renders without it.
 */
const MAX_AMOUNT_CHARS = 24;

/**
 * One validated number rendered in its declared unit, or null when the field is
 * absent, was not a finite non-negative number, or renders too wide to carry.
 */
function formatAmount(value: unknown, unit: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const text =
    unit === "bytes"
      ? `${(value / BYTES_PER_GIB).toFixed(2)} GiB`
      : unit === "gb"
        ? `${value.toFixed(2)} GB`
        : unit === "cores"
          ? `${value.toFixed(2)} cores`
          : `${Math.round(value)}`;
  return text.length <= MAX_AMOUNT_CHARS ? text : null;
}

/** A validated resource shape (`unsupported_shape` only) as `4 cpu / 8.00 GB / 20.00 GB disk`. */
function formatShape(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  const cpu = formatAmount(record["cpu"], "count");
  if (cpu !== null) parts.push(`${cpu} cpu`);
  const memoryGB = formatAmount(record["memoryGB"], "gb");
  if (memoryGB !== null) parts.push(`${memoryGB} memory`);
  const diskGB = formatAmount(record["diskGB"], "gb");
  if (diskGB !== null) parts.push(`${diskGB} disk`);
  return parts.length > 0 ? parts.join(" / ") : null;
}

/**
 * The numeric clause of a refusal, composed from the sanitized detail only.
 * Every value here already passed {@link sanitizeAdmissionDetails}; nothing is
 * read from the throw. Returns null when the host stated no usable numbers.
 */
function admissionAmounts(details: Record<string, unknown>): string | null {
  if (details["reason"] === "unsupported_shape") {
    const parts: string[] = [];
    const requested = formatShape(details["requested"]);
    if (requested !== null) parts.push(`requested ${requested}`);
    const maximum = formatShape(details["maximum"]);
    if (maximum !== null) parts.push(`host maximum ${maximum}`);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  const unit = details["unit"] as string;
  const parts: string[] = [];
  const required = formatAmount(details["required"], unit);
  if (required !== null) parts.push(`${required} required`);
  const available = formatAmount(details["available"], unit);
  if (available !== null) parts.push(`${available} available`);
  const clause = parts.join(", ");
  const budget = formatAmount(details["budget"], unit);
  // `committed` is deliberately not rendered: it is the least actionable of the
  // four and the message must stay inside the 120-char push body intact.
  if (budget === null) return clause.length > 0 ? clause : null;
  return clause.length > 0 ? `${clause} of ${budget} budget` : `${budget} budget`;
}

/**
 * The actionable sentence for a host admission refusal: the reason enum's own
 * static copy plus the validated numbers behind it, e.g.
 * `sandbox hosts at capacity (memory_capacity): 4.00 GiB required, 2.83 GiB
 * available of 2.83 GiB budget`.
 *
 * Fail-closed like everything else here. The argument is re-validated through
 * {@link sanitizeErrorDetails}, so a forged, malformed, or unknown-kind payload
 * answers null and the caller keeps today's generic message; the returned text
 * is a static literal plus allowlisted enums and re-rendered numbers, never a
 * substring of the host's own message or hint.
 */
export function renderAdmissionRefusal(details: unknown): string | null {
  const safe = sanitizeErrorDetails({ details });
  if (safe === undefined || safe["kind"] !== "admission") return null;
  const sentence = renderAdmissionMessage(safe);
  if (sentence === null) return null;
  const amounts = admissionAmounts(safe);
  if (amounts === null) return boundStaticText(sentence, MAX_ERROR_MESSAGE_CHARS);
  // The plain capacity sentence ends by naming the reason, so a colon introduces
  // the numbers; the per-reason sentences end in an instruction ("retry
  // shortly"), which reads as evidence in parentheses instead.
  const composed = sentence.endsWith(`(${safe["reason"] as string})`)
    ? `${sentence}: ${amounts}`
    : `${sentence} (${amounts})`;
  return boundStaticText(composed, MAX_ERROR_MESSAGE_CHARS);
}

/**
 * Locate the raw `details` payload a refusal carried. The sandbox adapter wraps
 * the host's `SandboxApiError` in a `PiPodError`, so the object sits one level
 * down on `cause` — only that property is read, never the cause's message,
 * name, or stack, and the payload is validated before anything is rendered.
 */
function refusalDetailsPayload(error: unknown): unknown {
  if (error === null || typeof error !== "object") return undefined;
  const own = (error as { details?: unknown }).details;
  if (own !== undefined) return own;
  const cause = (error as { cause?: unknown }).cause;
  if (cause === null || typeof cause !== "object") return undefined;
  return (cause as { details?: unknown }).details;
}

/**
 * Failure paths: the actionable capacity sentence for a throw that carried a
 * validated host admission refusal, or null for everything else.
 *
 * A refusal the host already explained in enums and numbers must not reach the
 * operator as `operation failed (507)` — on a self-hosted install that is the
 * difference between "shrink the pod or free 1.2 GiB" and an unfalsifiable
 * failure. Callers use it exactly like {@link sanitizeFailureMessage}: take
 * this when it answers, fall back to the generic message when it does not.
 */
export function describeAdmissionRefusal(error: unknown): string | null {
  return renderAdmissionRefusal(refusalDetailsPayload(error));
}

/**
 * Provider/SDK failures for client-visible surfaces (`state_reason`, fleet JSON,
 * warnings). Only an allowlisted transport token survives, with a generic message;
 * 507 keeps capacity wording because placement retry and operator action depend on
 * it. The SDK message behind the code is always dropped.
 */
export function describeProviderFailure(_error: unknown, _max = 300): string {
  const code = extractAllowlistedCode(_error);
  if (code === "507") return `507: ${GENERIC_CAPACITY_FAILED}`;
  if (code !== null) return `${code}: ${GENERIC_PROVIDER_FAILED}`;
  return GENERIC_PROVIDER_FAILED;
}

/**
 * Typed fleet-unavailable 503s that may cross the HTTP boundary as 503.
 *
 * On 2026-09-07 `POST /pods/resolve` during a server→host partition threw a
 * bare 503 with no allowlisted code; the sanitizer genericized it to
 * "operation failed" and the handler answered 500 `internal server error`,
 * hiding a retryable fleet outage behind an opaque failure. A placement
 * throw that carries exactly this detail shape is an actionable client
 * signal (retryable, bounded hint) — not a server fault — so the HTTP
 * boundary answers 503 with the static message below plus a validated copy
 * of the detail. Anything unrecognized still fails closed to 500.
 *
 * The `kind: "fleet"` discriminator is deliberately NOT `admission`: an
 * unreachable fleet is not host admission evidence, so wait-queue
 * classification (`toRefusal`, `resolveWalkExhaustion`) keeps treating it
 * as non-retryable fail-fast — the launch path's wait behaviour is unchanged.
 */
export const FLEET_UNAVAILABLE_CODE = "fleet_unavailable";
export const FLEET_UNAVAILABLE_MESSAGE = "the sandbox fleet is unreachable; retry shortly";
/** Client re-probe hint for an unreachable fleet, bounded per contract (≤300s). */
export const FLEET_UNAVAILABLE_RETRY_AFTER_MS = 15_000;

export interface FleetUnavailableDetail {
  code: typeof FLEET_UNAVAILABLE_CODE;
  reason: typeof FLEET_UNAVAILABLE_CODE;
  retryable: true;
  retryAfterMs: number;
}

/**
 * Recognize a server-constructed fleet-unavailable throw at the HTTP 500
 * boundary. Strict shape check (503 + `fleet_unavailable` code/reason +
 * literal `retryable: true` + finite 0–300s hint): returns a fresh copy with
 * exactly the allowlisted fields, never the input — forged extra fields
 * (or a hostile hint) fail the check and stay on the generic 500 path.
 */
export function fleetUnavailableDetail(error: unknown): FleetUnavailableDetail | null {
  if (!(error instanceof HttpError) || error.statusCode !== 503) return null;
  const detail = (error as { detail?: unknown }).detail;
  if (detail === null || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  if (record["kind"] !== "fleet") return null;
  if (record["code"] !== FLEET_UNAVAILABLE_CODE) return null;
  if (record["reason"] !== FLEET_UNAVAILABLE_CODE) return null;
  if (record["retryable"] !== true) return null;
  const retryAfterMs = record["retryAfterMs"];
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs)) return null;
  // Round before the range check so the validated bound applies to the
  // value actually returned, never one millisecond under it.
  const hintMs = Math.round(retryAfterMs);
  if (hintMs < 0 || hintMs > 300_000) {
    return null;
  }
  return {
    code: FLEET_UNAVAILABLE_CODE,
    reason: FLEET_UNAVAILABLE_CODE,
    retryable: true,
    retryAfterMs: hintMs,
  };
}

/**
 * Typed Boat host-demand 503s that may cross the HTTP boundary as 503.
 *
 * On 2026-09-09, with `SANDBOX_HOST_BACKEND=boat` live and a personal host
 * asleep, `POST /v1/pods/:id/files` answered 500 `internal server error` on
 * every retry while the durable `resume` was already committed: the retryable
 * `host_starting` signal documented in docs/boat-placement.md reached the
 * boundary as a 503 that matched neither existing allowlist and fell through
 * to the generic 500. The WS path special-cases these reasons in
 * gateway/routes.ts and pod launch converts them during planning, so the REST
 * send/receive/file paths were the ones that never delivered the contract.
 *
 * A host-demand throw describes the caller's OWN workstation lifecycle — it is
 * an actionable client signal (poll the owned status, retry the same pod), not
 * a server fault. Three sites throw this shape: `requireHostAwake`
 * (host_stopped/host_deleted/host_starting), `ensureOwnedHostReady`
 * (host_starting, with the status href and sanitized operation) and its
 * `BoatControlError` conversion. Reasons that name control-plane internals
 * instead of that workstation — `invalid_boat_pins`, `user_missing`,
 * `host_org_mismatch` — are deliberately absent from the allowlist: they are
 * genuine server faults and still fail closed to 500, as does every
 * unrecognized or malformed shape.
 */
export const BOAT_HOST_DEMAND_REASONS = [
  // The workstation is coming up (or a durable resume was just committed).
  "host_starting",
  // It is asleep / was deleted: the owner's own lifecycle state, and the same
  // pair the WS close path already reports.
  "host_stopped",
  "host_deleted",
  // Terminal for this workstation (retryable:false): create a new one.
  "host_retired",
  // Ambiguous durable state the controller must settle first; already
  // classified as a retryable host wait by workers/jobs.ts.
  "host_requires_reconciliation",
  // Operator-initiated pause on starts; retryable, and likewise already a
  // host-wait reason in workers/jobs.ts.
  "boat_starts_disabled",
] as const;
export type BoatHostDemandReason = (typeof BOAT_HOST_DEMAND_REASONS)[number];
const BOAT_HOST_DEMAND_REASON_SET: ReadonlySet<string> = new Set(BOAT_HOST_DEMAND_REASONS);

/** Generic fallback copy; per-reason static copy lives in the table below. */
export const BOAT_HOST_DEMAND_MESSAGE = "your workstation is not ready; poll its status and retry";

/** Static copy per validated reason — never interpolated from the throw. */
const BOAT_HOST_DEMAND_COPY: Record<BoatHostDemandReason, string> = {
  host_starting: "Your workstation is starting. This may take several minutes",
  host_stopped: "your workstation is asleep; start it, then retry",
  host_deleted: "your workstation has been deleted; create a new one",
  host_retired: "your workstation has been retired; create a new one",
  host_requires_reconciliation: "your workstation is being reconciled; retry shortly",
  boat_starts_disabled: "workstation starts are temporarily paused; retry shortly",
};

/**
 * Render the client copy for a validated host-demand detail from its reason
 * enum alone. Unknown reasons fall back to the generic sentence, so no caller
 * text can reach the body.
 */
export function renderBoatHostDemand(detail: { reason: string }): string {
  // `Object.hasOwn`, not a plain lookup: a reason of "constructor" or "toString"
  // would otherwise read the object prototype and return a function as copy.
  if (!Object.hasOwn(BOAT_HOST_DEMAND_COPY, detail.reason)) return BOAT_HOST_DEMAND_MESSAGE;
  return BOAT_HOST_DEMAND_COPY[detail.reason as BoatHostDemandReason];
}

/**
 * One read of each own data property, into a null-prototype object.
 *
 * The recognizers below validate a field and then read it again to copy it. On
 * the throw sites we own that is identical, but a hostile object could make the
 * two reads disagree with an accessor, and an inherited property would answer a
 * lookup the sanitizer never meant to accept. Snapshotting first removes both:
 * accessors are dropped entirely (only `value` descriptors survive) and the
 * prototype chain is gone, so every later `record[key]` is the same plain value.
 */
function ownDataProperties(value: object): Record<string, unknown> {
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/** The same host-id shape the workstation routes accept as a path parameter. */
const BOAT_HOST_ID_RULE = /^boat-[A-Za-z0-9._-]{1,180}$/;
/** `sandbox_hosts.boat_state`. */
const BOAT_HOST_STATES: ReadonlySet<string> = new Set([
  "provisioning", "starting", "running", "stopping", "stopped", "error", "unknown", "deleting", "deleted",
]);
/** Mirrors the `boat_operations.kind` CHECK constraint, including the legacy
 * `publish` value: a row the column still permits must not reopen the 500. */
const BOAT_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "create", "resume", "stop", "delete", "publish", "activate", "ttl",
]);
/** Mirrors the `boat_operations.state` CHECK constraint. */
const BOAT_OPERATION_STATES: ReadonlySet<string> = new Set([
  "pending", "running", "uncertain", "succeeded", "failed", "cancelled",
]);
const BOAT_OPERATION_ID_RULE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Controller phase names and error codes: bounded slugs, never host text. */
const BOAT_PHASE_RULE = /^[A-Za-z0-9._:-]{1,64}$/;
const BOAT_ERROR_CODE_RULE = /^[A-Za-z0-9._-]{1,64}$/;
/** ISO-8601 instant with a 4-digit year; re-rendered, never echoed. */
const ISO_INSTANT_RULE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A canonical UTC instant recomputed from a `Date` (what pg hands back) or a
 * bounded ISO-8601 string. The emitted value is always re-rendered from the
 * parsed instant, so no caller-supplied string survives.
 */
function isoInstant(value: unknown): string | null {
  const parsed =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string" && value.length <= 40 && ISO_INSTANT_RULE.test(value)
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

export interface BoatHostDemandOperation {
  id: string;
  kind: string;
  state: string;
  phase: string;
  deadlineAt: string;
  retryAt: string | null;
  errorCode: string | null;
}

export interface BoatHostDemandDetail {
  kind: "admission";
  reason: BoatHostDemandReason;
  resource: "transitions";
  unit: "count";
  retryable: boolean;
  hostId?: string;
  statusHref?: string;
  state?: string;
  retryAfterMs?: number;
  operation?: BoatHostDemandOperation | null;
}

/**
 * Exactly the fields `GET /v1/workstations/:hostId` already exposes, each
 * validated against the column that produced it. Every key must be present
 * (the status projection always writes all seven); anything else is dropped by
 * construction, because the result is built fresh rather than copied.
 */
function boatHostDemandOperation(value: unknown): BoatHostDemandOperation | null {
  if (value === null || typeof value !== "object") return null;
  const record = ownDataProperties(value);
  if (typeof record["id"] !== "string" || !BOAT_OPERATION_ID_RULE.test(record["id"])) return null;
  if (!BOAT_OPERATION_KINDS.has(record["kind"] as string)) return null;
  if (!BOAT_OPERATION_STATES.has(record["state"] as string)) return null;
  if (typeof record["phase"] !== "string" || !BOAT_PHASE_RULE.test(record["phase"])) return null;
  const deadlineAt = isoInstant(record["deadlineAt"]);
  if (deadlineAt === null) return null;
  let retryAt: string | null = null;
  if (record["retryAt"] !== null) {
    retryAt = isoInstant(record["retryAt"]);
    if (retryAt === null) return null;
  }
  let errorCode: string | null = null;
  if (record["errorCode"] !== null) {
    if (typeof record["errorCode"] !== "string" || !BOAT_ERROR_CODE_RULE.test(record["errorCode"])) return null;
    errorCode = record["errorCode"];
  }
  return {
    id: record["id"],
    kind: record["kind"] as string,
    state: record["state"] as string,
    phase: record["phase"],
    deadlineAt,
    retryAt,
    errorCode,
  };
}

/**
 * Recognize a server-constructed Boat host-demand throw at the HTTP 500
 * boundary. Strict shape check (503 + `kind: "admission"` + an allowlisted
 * reason + the transition budget every demand site states + a literal boolean
 * `retryable`): returns a fresh object with exactly the allowlisted fields,
 * never the input and never a spread of it, so forged extra fields cannot ride
 * along. Every optional field is validated against the shape that produced it
 * — the host id against the workstation routes' own rule, the status href
 * recomputed from that id and compared rather than copied, the retry hint
 * bounded to the same 0–300s window as the fleet hint — and a present-but-
 * malformed field fails the whole check, leaving the throw on the generic 500
 * path.
 */
export function boatHostDemandDetail(error: unknown): BoatHostDemandDetail | null {
  if (!(error instanceof HttpError) || error.statusCode !== 503) return null;
  const detail = (error as { detail?: unknown }).detail;
  if (detail === null || typeof detail !== "object") return null;
  const record = ownDataProperties(detail);
  if (record["kind"] !== "admission") return null;
  if (typeof record["reason"] !== "string" || !BOAT_HOST_DEMAND_REASON_SET.has(record["reason"])) return null;
  // Every host-demand site names the transition budget it is waiting on; a
  // shape that does not is not one of ours.
  if (record["resource"] !== "transitions" || record["unit"] !== "count") return null;
  if (typeof record["retryable"] !== "boolean") return null;
  const out: BoatHostDemandDetail = {
    kind: "admission",
    reason: record["reason"] as BoatHostDemandReason,
    resource: "transitions",
    unit: "count",
    retryable: record["retryable"],
  };
  if (record["hostId"] !== undefined) {
    if (typeof record["hostId"] !== "string" || !BOAT_HOST_ID_RULE.test(record["hostId"])) return null;
    // Recompute the link from the validated id and compare: a caller-influenced
    // string must never be handed back as a URL.
    const statusHref = `/v1/workstations/${encodeURIComponent(record["hostId"])}`;
    if (record["statusHref"] !== undefined && record["statusHref"] !== statusHref) return null;
    out.hostId = record["hostId"];
    out.statusHref = statusHref;
  } else if (record["statusHref"] !== undefined) {
    // An href without the id that must generate it is a forged shape.
    return null;
  }
  // `boat_state` is nullable on a static row, so absent and null both mean
  // "no state to report" rather than a malformed detail.
  if (record["state"] !== undefined && record["state"] !== null) {
    if (!BOAT_HOST_STATES.has(record["state"] as string)) return null;
    out.state = record["state"] as string;
  }
  if (record["retryAfterMs"] !== undefined) {
    const hint = record["retryAfterMs"];
    if (typeof hint !== "number" || !Number.isFinite(hint)) return null;
    // Round before the range check so the validated bound applies to the value
    // actually returned, exactly as the fleet hint does.
    const hintMs = Math.round(hint);
    if (hintMs < 0 || hintMs > 300_000) return null;
    out.retryAfterMs = hintMs;
  }
  if (record["operation"] !== undefined) {
    if (record["operation"] === null) {
      // The status projection reports "no unfinished operation" as null; keep
      // that answer rather than an ambiguous missing key.
      out.operation = null;
    } else {
      const operation = boatHostDemandOperation(record["operation"]);
      if (operation === null) return null;
      out.operation = operation;
    }
  }
  return out;
}

/**
 * What reaches the log for an unhandled throw: a generic message plus allowlisted
 * transport tokens only. Stacks, names, causes, configs, responses, bodies, and
 * headers are deliberately dropped — provider SDK errors attach all of those, and
 * pino's default `err` serializer would otherwise persist them.
 */
export function sanitizeForLog(error: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { message: GENERIC_OPERATION_FAILED };
  if (error === null || typeof error !== "object") return out;
  const record = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  const code = allowlistedCodeToken(record.code);
  if (code !== null) out.code = code;
  // status/statusCode share the numeric transport namespace; surface the first one.
  const status = allowlistedCodeToken(record.status ?? record.statusCode);
  if (status !== null) out.statusCode = Number(status);
  return out;
}

/** Query parameters whose values are credentials: WebSocket tickets, OAuth codes, tokens. */
const SECRET_QUERY_PARAM = /ticket|token|secret|password|key|^code$/i;

/**
 * `url` with credential-bearing query values replaced by `REDACTED`. WebSocket clients carry
 * their one-shot ticket in the URL, and pino's path redaction cannot reach inside a string.
 */
export function redactUrlForLog(url: string): string {
  const start = url.indexOf("?");
  if (start < 0) return url;
  const params = new URLSearchParams(url.slice(start + 1));
  const secret = [...new Set(params.keys())].filter((name) => SECRET_QUERY_PARAM.test(name));
  if (secret.length === 0) return url;
  for (const name of secret) params.set(name, "REDACTED");
  return `${url.slice(0, start)}?${params.toString()}`;
}

/**
 * Pino `redact` paths: request/response fields that must never persist. Entire
 * bodies are redacted by default so a future serializer must opt out explicitly
 * rather than leak by default; sensitive headers and known secret-bearing fields
 * are listed explicitly plus wildcard fallbacks for variant spellings.
 */
export const PINO_REDACT_PATHS = [
  // Entire bodies first: fail-closed default.
  "req.body",
  "body",
  // Authorization / cookie headers (dot and bracket spellings).
  "req.headers.authorization",
  "req.headers['authorization']",
  "req.headers.cookie",
  "req.headers['cookie']",
  "req.headers['proxy-authorization']",
  "req.headers['x-api-key']",
  "req.headers['x-auth-token']",
  "req.headers['x-access-token']",
  "req.headers['set-cookie']",
  "res.headers['set-cookie']",
  // Explicit secret-bearing body fields (defense in depth under the body redact).
  "req.body.value",
  "req.body.secret",
  "req.body.password",
  "req.body.token",
  "body.value",
  "body.secret",
  "body.password",
  "body.token",
  // Wildcard fallbacks for variant spellings across serializers.
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.secret",
  "*.password",
  "*.apiKey",
  "*.api_key",
  "*.accessToken",
  "*.refreshToken",
  "*.clientSecret",
];

/**
 * Old-client compatibility: POST /v1/pods (and /pods/resolve) with a retired
 * provider (e2b/daytona) fails zod-enum validation before the handler runs.
 * The generic scrub below drops the enum's allowed-value list by design (it
 * lives in `message`/`params` alongside the received value), so detect the
 * provider location here and let the HTTP boundary answer with the static
 * registry-driven list. Only the location + rule are read — never
 * message/params/data, so no credential or raw-body echo is possible.
 */
export function isProviderValidationFailure(validation: unknown): boolean {
  if (!Array.isArray(validation)) return false;
  return validation.some((issue) => {
    if (issue === null || typeof issue !== "object") return false;
    const record = issue as Record<string, unknown>;
    if (record["instancePath"] !== "/provider") return false;
    // fastify-type-provider-zod reports zod enum failures as keyword
    // invalid_enum_value, schemaPath #/provider/invalid_enum_value. Accept any
    // keyword at /provider so type errors hint the list too.
    if (typeof record["keyword"] === "string" && (record["keyword"] as string).length > 0) return true;
    if (typeof record["schemaPath"] === "string" && (record["schemaPath"] as string).includes("/provider")) return true;
    return false;
  });
}

/**
 * Fastify/Zod validation details echo the *shape* of a bad request. Keep the
 * location and the rule, drop everything else — `message` can embed enum
 * allowed-value lists and received values, and `params`/`data` would be the raw
 * body. A rejected secret value must never round-trip through the error payload.
 */
export function scrubValidationIssues(validation: unknown): unknown {
  if (!Array.isArray(validation)) return null;
  return validation.map((issue) => {
    if (issue === null || typeof issue !== "object") return null;
    const record = issue as Record<string, unknown>;
    const scrubbed: Record<string, unknown> = {};
    if (typeof record["instancePath"] === "string") {
      scrubbed.instancePath = boundStaticText(record["instancePath"], 200);
    }
    if (typeof record["schemaPath"] === "string") {
      scrubbed.schemaPath = boundStaticText(record["schemaPath"], 200);
    }
    if (typeof record["keyword"] === "string") {
      scrubbed.keyword = boundStaticText(record["keyword"], 100);
    }
    // Deliberately no message / params / data: arbitrary echo is dropped.
    return scrubbed;
  });
}
