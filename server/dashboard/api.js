// @ts-check
/** Calls to this server's /v1 API as the signed-in person. */
import { accessToken, refreshedAccessToken } from "./auth.js";

/** A refused request, carrying the server's own message and validation detail. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {unknown} [detail]
   */
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }

  /** The server's detail as lines a person can read: validation paths, hints. */
  get lines() {
    const detail = this.detail;
    if (Array.isArray(detail)) return detail.map((line) => (typeof line === "string" ? line : JSON.stringify(line)));
    if (typeof detail === "string") return [detail];
    return [];
  }
}

/**
 * @param {"GET" | "POST" | "PUT" | "PATCH" | "DELETE"} method
 * @param {string} path below /v1
 * @param {unknown} [body]
 * @returns {Promise<any>} the response's JSON, or null for an empty one
 */
export async function api(method, path, body) {
  /** @param {string} token */
  const send = (token) =>
    fetch(`/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let token = await accessToken();
  if (!token) throw new ApiError(401, "signed out");
  let res = await send(token);
  if (res.status === 401) {
    // Expired early or revoked: one renewal, then the person has to sign in again.
    token = await refreshedAccessToken();
    if (!token) throw new ApiError(401, "signed out");
    res = await send(token);
  }
  const text = await res.text();
  /** @type {any} */
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`, json?.detail);
  return json;
}
