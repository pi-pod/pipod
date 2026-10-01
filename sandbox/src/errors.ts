import {
  ERR_ADMISSION,
  ERR_ARCHIVE_MISMATCH,
  ERR_CONFLICT,
  ERR_IDEMPOTENCY_CONFLICT,
  ERR_IMAGE_MISMATCH,
  ERR_NOT_FOUND,
  ERR_OWNER_CONFLICT,
  ERR_OWNER_REQUIRED,
  ERR_PAYLOAD_TOO_LARGE,
  ERR_SANDBOX_HELD,
  ERR_STALE_REVISION,
  ERR_TIMEOUT,
  ERR_UNAUTHORIZED,
  ERR_UNSUPPORTED_SHAPE,
  type AdmissionErrorDetails,
  type ArchiveErrorDetails,
  type ErrorDetails,
  type SandboxHold,
  type OperationErrorDetails,
  type ResourceShape,
  type RevisionErrorDetails,
} from "./wire.js";

export class ServiceError extends Error {
  readonly details?: ErrorDetails;

  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly hint?: string,
    details?: ErrorDetails,
  ) {
    super(message);
    this.name = "ServiceError";
    if (details) this.details = details;
  }

  /** The wire body. Details are already validated numbers/enums; the message is advisory. */
  toWire(): { code: string; message: string; hint?: string; details?: ErrorDetails } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export const notFound = (what: string, hint?: string) =>
  new ServiceError(what, ERR_NOT_FOUND, 404, hint);
export const conflict = (message: string, hint?: string) =>
  new ServiceError(message, ERR_CONFLICT, 409, hint);
export const unauthorized = () =>
  new ServiceError("invalid or missing bearer token", ERR_UNAUTHORIZED, 401);
export const timedOut = (message: string) => new ServiceError(message, ERR_TIMEOUT, 504);
export const badRequest = (message: string, hint?: string) =>
  new ServiceError(message, "bad_request", 400, hint);
export const payloadTooLarge = (message: string, hint?: string) =>
  new ServiceError(message, ERR_PAYLOAD_TOO_LARGE, 413, hint);

/** Legacy free-form admission refusal; prefer {@link capacityDenied} so clients get numbers. */
export const admissionDenied = (message: string, hint?: string) =>
  new ServiceError(message, ERR_ADMISSION, 507, hint);

const GB = 1024 ** 3;

function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatAmount(value: number, unit: AdmissionErrorDetails["unit"]): string {
  switch (unit) {
    case "bytes":
      return `${(value / GB).toFixed(2)} GiB`;
    case "cores":
      return `${value.toFixed(2)} cores`;
    case "gb":
      return `${value} GB`;
    case "count":
      return String(value);
  }
}

/**
 * A capacity refusal whose message is rendered *from* validated numbers, so the safe
 * information a client needs survives sanitizers that drop raw provider text (§6.3).
 */
export function capacityDenied(
  input: Omit<AdmissionErrorDetails, "kind" | "retryable"> & { retryable?: boolean },
  hint?: string,
): ServiceError {
  const details: AdmissionErrorDetails = {
    kind: "admission",
    reason: input.reason,
    resource: input.resource,
    unit: input.unit,
    retryable: input.retryable ?? input.reason !== "unsupported_shape",
  };
  const required = finite(input.required);
  const available = finite(input.available);
  const budget = finite(input.budget);
  const committed = finite(input.committed);
  const retryAfterMs = finite(input.retryAfterMs);
  if (required !== undefined) details.required = required;
  if (available !== undefined) details.available = available;
  if (budget !== undefined) details.budget = budget;
  if (committed !== undefined) details.committed = committed;
  if (retryAfterMs !== undefined) details.retryAfterMs = Math.min(retryAfterMs, 5 * 60_000);
  if (input.requested) details.requested = input.requested;
  if (input.maximum) details.maximum = input.maximum;

  const facts: string[] = [];
  if (required !== undefined) facts.push(`${formatAmount(required, input.unit)} requested`);
  if (available !== undefined) facts.push(`${formatAmount(available, input.unit)} available`);
  if (committed !== undefined && budget !== undefined) {
    facts.push(`${formatAmount(committed, input.unit)} committed of ${formatAmount(budget, input.unit)}`);
  }
  let message: string;
  if (input.reason === "memory_debt") {
    const debt = committed !== undefined && budget !== undefined ? Math.max(0, committed - budget) : 0;
    message = `memory commitments already exceed the admission budget by ${formatAmount(debt, "bytes")}; new admissions are blocked until the debt drains`;
  } else if (input.reason === "transition_capacity") {
    message = `too many sandbox transitions in flight${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`;
  } else {
    message = `${input.resource} capacity exhausted${facts.length > 0 ? `: ${facts.join(", ")}` : ""}`;
  }
  return new ServiceError(
    message,
    ERR_ADMISSION,
    507,
    hint ?? "stop, archive or delete an idle sandbox, or place the request on another host",
    details,
  );
}

/** A shape this host does not support at all; never a retryable capacity condition (§7.4). */
export function unsupportedShape(
  requested: Partial<ResourceShape>,
  maximum: ResourceShape,
  hint?: string,
): ServiceError {
  const details: AdmissionErrorDetails = {
    kind: "admission",
    reason: "unsupported_shape",
    resource: "shape",
    unit: "gb",
    retryable: false,
    requested,
    maximum,
  };
  const over: string[] = [];
  if (requested.memoryGB !== undefined && requested.memoryGB > maximum.memoryGB) {
    over.push(`memory ${requested.memoryGB} GiB > ${maximum.memoryGB} GiB`);
  }
  if (requested.cpu !== undefined && requested.cpu > maximum.cpu) {
    over.push(`cpu ${requested.cpu} > ${maximum.cpu}`);
  }
  if (requested.diskGB !== undefined && requested.diskGB > maximum.diskGB) {
    over.push(`disk ${requested.diskGB} GB > ${maximum.diskGB} GB`);
  }
  return new ServiceError(
    `requested sandbox shape exceeds this host's maximum (${over.join(", ") || "unsupported"})`,
    ERR_UNSUPPORTED_SHAPE,
    400,
    hint ?? "choose a host that advertises the shape in its capacity report, or request a smaller shape",
    details,
  );
}

export function staleRevision(expected: number, actual: number, what: string): ServiceError {
  const details: RevisionErrorDetails = { kind: "revision", expected, actual };
  return new ServiceError(
    `${what} revision ${expected} is not current (now ${actual})`,
    ERR_STALE_REVISION,
    409,
    "re-read the current state and retry with its revision",
    details,
  );
}

export function ownerConflict(message: string, hint?: string): ServiceError {
  return new ServiceError(message, ERR_OWNER_CONFLICT, 409, hint);
}

export function ownerRequired(what: string): ServiceError {
  return new ServiceError(
    `${what} requires an owner on this host`,
    ERR_OWNER_REQUIRED,
    400,
    "initialize the owner with PUT /v1/sandboxes/{id}/owner (or pass owner on create) before launching",
  );
}

export function sandboxHeld(id: string, hold: SandboxHold, what: string): ServiceError {
  return new ServiceError(
    `sandbox ${id} is held by ${hold.holder}; ${what} is refused until the hold is released`,
    ERR_SANDBOX_HELD,
    409,
    "release the hold with DELETE /v1/sandboxes/{id}/hold once the rehome or maintenance completes",
    { kind: "hold", holder: hold.holder, since: hold.since },
  );
}

export function archiveMismatch(
  expected: ArchiveErrorDetails["expected"],
  actual: ArchiveErrorDetails["actual"],
): ServiceError {
  const why = !actual.present
    ? "object is missing"
    : actual.size !== null && expected.size !== undefined && actual.size !== expected.size
      ? `size ${actual.size} != ${expected.size}`
      : "checksum differs";
  return new ServiceError(
    `archive object ${expected.key} cannot be adopted: ${why}`,
    ERR_ARCHIVE_MISMATCH,
    409,
    "re-read the source's archive reference; the target adopts only the exact object it was given",
    { kind: "archive", expected, actual },
  );
}

export function imageMismatch(ref: string, expected: string, actual: string): ServiceError {
  return new ServiceError(
    `image ${ref} resolves to ${actual.slice(0, 19)}… on this host but the source recorded ${expected.slice(0, 19)}…`,
    ERR_IMAGE_MISMATCH,
    409,
    "pull the exact image the source used (pin by digest) before importing, or import without imageDigest to accept the difference explicitly",
  );
}

export function idempotencyConflict(details: Omit<OperationErrorDetails, "kind">): ServiceError {
  return new ServiceError(
    `operation ${details.operationKey} was already used for a different request`,
    ERR_IDEMPOTENCY_CONFLICT,
    409,
    "use a new operation key for a different request; look up the original with GET /v1/operations/{key}",
    { kind: "operation", ...details },
  );
}
