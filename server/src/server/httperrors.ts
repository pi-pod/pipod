export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const launchAdmissionHeldErrors = new WeakSet<object>();

export const LAUNCH_ADMISSION_HELD_CODE = "launch_admission_held";
export const LAUNCH_ADMISSION_HELD_MESSAGE = "new launches are temporarily paused";

/** Only this locally issued error may cross the HTTP boundary as held admission. */
export function launchAdmissionHeldError(): HttpError {
  const error = new HttpError(503, LAUNCH_ADMISSION_HELD_MESSAGE, {
    code: LAUNCH_ADMISSION_HELD_CODE,
    retryable: true,
  });
  launchAdmissionHeldErrors.add(error);
  return error;
}

/** Provenance check; callers must still validate mutable status/detail fields. */
export function isLaunchAdmissionHeldError(error: unknown): error is HttpError {
  return typeof error === "object" && error !== null && launchAdmissionHeldErrors.has(error);
}

export const badRequest = (msg: string, detail?: unknown) => new HttpError(400, msg, detail);
export const unauthorized = (msg = "unauthorized") => new HttpError(401, msg);
export const forbidden = (msg = "forbidden") => new HttpError(403, msg);
export const notFound = (msg = "not found") => new HttpError(404, msg);
/** A plan, trial or spend-cap refusal: terminal until the account changes, never retried on a timer. */
export const paymentRequired = (msg: string, detail?: unknown) => new HttpError(402, msg, detail);
export const conflict = (msg: string, detail?: unknown) => new HttpError(409, msg, detail);
export const gone = (msg: string, detail?: unknown) => new HttpError(410, msg, detail);
export const payloadTooLarge = (msg: string, detail?: unknown) => new HttpError(413, msg, detail);
export const tooManyRequests = (msg: string, detail?: unknown) => new HttpError(429, msg, detail);
export const serviceUnavailable = (msg: string, detail?: unknown) => new HttpError(503, msg, detail);
