/**
 * src/account/limited-sign-in.ts — the machine's side of a limited sign-in
 * (`pipod login --device --template <name>`).
 *
 * The server, not the identity provider, issues these tokens: the person confirms on the server's
 * own page, which names the template, and the server keeps the person's identity-provider session
 * to itself. So this machine never holds a token that works at the identity provider or without
 * the limit. The endpoints are OAuth-shaped — RFC 8628 to start, the device-code and refresh-token
 * grants at /v1/sign-ins/token, RFC 7009 to revoke — and take no bearer token.
 */
import { PiPodError } from "../errors.js";

const NETWORK_TIMEOUT_MS = 15_000;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface LimitedDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSeconds: number;
  expiresAt: number;
}

export interface LimitedTokens {
  accessToken: string;
  refreshToken: string;
  templateId: string;
  templateName: string;
}

export function limitedTokenEndpoint(serverUrl: string): string {
  return new URL("/v1/sign-ins/token", serverUrl).toString();
}

async function post(url: string, body: Record<string, string>, json = false): Promise<Response | null> {
  return fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded" },
    body: json ? JSON.stringify(body) : new URLSearchParams(body),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  }).catch(() => null);
}

async function oauthError(res: Response): Promise<{ error: string; description: string }> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const error = typeof body?.["error"] === "string" ? body["error"] : `HTTP ${res.status}`;
  const description = typeof body?.["error_description"] === "string" ? body["error_description"] : error;
  return { error, description };
}

/** Ask the server for a sign-in limited to `template` (a name or an id), to be confirmed by a person. */
export async function startLimitedSignIn(serverUrl: string, template: string): Promise<LimitedDeviceAuthorization> {
  const res = await post(new URL("/v1/sign-ins/device", serverUrl).toString(), { template }, true);
  if (!res) throw new PiPodError(`cannot reach the pi pod server at ${serverUrl}`);
  if (res.status === 404) {
    throw new PiPodError(`${serverUrl} does not offer sign-ins limited to a template`, {
      hint: "the server needs an upgrade; until then only `pipod login --device` (the whole account) is possible",
    });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new PiPodError(`the server refused to start a limited sign-in: ${typeof body?.error === "string" ? body.error : `HTTP ${res.status}`}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const deviceCode = body?.["device_code"];
  const userCode = body?.["user_code"];
  const verificationUri = body?.["verification_uri"];
  const verificationUriComplete = body?.["verification_uri_complete"];
  const expiresIn = body?.["expires_in"];
  const interval = body?.["interval"];
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof verificationUriComplete !== "string" ||
    typeof expiresIn !== "number"
  ) {
    throw new PiPodError("the server returned an invalid sign-in request");
  }
  // The person is sent to the server they are signing in to, nowhere else.
  for (const page of [verificationUri, verificationUriComplete]) {
    if (new URL(page).origin !== new URL(serverUrl).origin && !new URL(page).protocol.startsWith("https")) {
      throw new PiPodError("the server named a confirmation page that is neither its own nor HTTPS");
    }
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds: typeof interval === "number" && interval > 0 ? interval : 5,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

function grantTokens(body: Record<string, unknown> | null): LimitedTokens {
  const accessToken = body?.["access_token"];
  const refreshToken = body?.["refresh_token"];
  const limited = body?.["limited_to"] as Record<string, unknown> | undefined;
  const templateId = limited?.["template_id"];
  const templateName = limited?.["template_name"];
  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    typeof templateId !== "string" ||
    typeof templateName !== "string"
  ) {
    throw new PiPodError("the server returned an invalid limited sign-in");
  }
  return { accessToken, refreshToken, templateId, templateName };
}

/** Wait for the person to confirm (or decline) on the server's page, then collect the sign-in. */
export async function awaitLimitedSignIn(serverUrl: string, authorization: LimitedDeviceAuthorization): Promise<LimitedTokens> {
  let intervalSeconds = authorization.intervalSeconds;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
    if (Date.now() >= authorization.expiresAt) {
      throw new PiPodError("the sign-in code expired before it was confirmed", { hint: "run the command again" });
    }
    const res = await post(limitedTokenEndpoint(serverUrl), {
      grant_type: DEVICE_CODE_GRANT,
      device_code: authorization.deviceCode,
    });
    if (!res) continue;
    if (res.ok) return grantTokens((await res.json().catch(() => null)) as Record<string, unknown> | null);
    const { error, description } = await oauthError(res);
    switch (error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalSeconds += 5;
        continue;
      case "access_denied":
        throw new PiPodError("the sign-in was declined", { hint: "run the command again" });
      case "expired_token":
        throw new PiPodError("the sign-in code expired before it was confirmed", { hint: "run the command again" });
      default:
        if (res.status >= 500) continue;
        throw new PiPodError(`the server refused the sign-in: ${description}`, { hint: "run the command again" });
    }
  }
}

/**
 * A fresh access token for a limited sign-in. An ended sign-in (logged out, the account's session
 * over, the account removed) is final; a server that cannot answer right now is transient.
 */
export async function renewLimitedSignIn(
  tokenEndpoint: string,
  refreshToken: string,
  templateName: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await post(tokenEndpoint, { grant_type: "refresh_token", refresh_token: refreshToken });
  if (!res) {
    throw new PiPodError(`cannot reach the pi pod server to renew this sign-in`, { transient: true });
  }
  if (res.ok) {
    const tokens = grantTokens((await res.json().catch(() => null)) as Record<string, unknown> | null);
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  }
  const { error, description } = await oauthError(res);
  if (res.status >= 500 || error === "temporarily_unavailable") {
    throw new PiPodError(`the server could not renew this sign-in right now: ${description}`, { transient: true });
  }
  throw new PiPodError(`this sign-in has ended: ${description}`, {
    hint: `sign in again with \`pipod login --device --template ${templateName}\``,
    status: 401,
  });
}

/** End a limited sign-in on the server. Unknown or ended tokens are not an error. */
export async function endLimitedSignIn(serverUrl: string, refreshToken: string): Promise<boolean> {
  const res = await post(new URL("/v1/sign-ins/revoke", serverUrl).toString(), { token: refreshToken });
  return res?.ok ?? false;
}
