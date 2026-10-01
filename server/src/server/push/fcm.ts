import { SignJWT, importPKCS8 } from "jose";
import type { ServerEnv } from "../env.js";
import type { PushPayload } from "./queue.js";

const ACCESS_TOKEN_TTL_MS = 50 * 60 * 1000;
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

export interface FcmResult {
  ok: boolean;
  status: number;
  reason: string | null;
  /** FCM says this registration token is dead — prune the device row. */
  tokenGone: boolean;
}

export function fcmMessage(token: string, payload: PushPayload): {
  message: {
    token: string;
    notification: { title: string; body: string };
    data: Record<string, string>;
  };
} {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.data)) {
    if (value !== undefined) data[key] = String(value);
  }
  return {
    message: {
      token,
      notification: { title: payload.title, body: payload.body },
      data,
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function fcmFailure(
  body: unknown,
  status: number,
  statusText: string,
): { reason: string | null; tokenGone: boolean } {
  const error = record(record(body)?.["error"]);
  let fcmCode: string | null = null;
  const details = error?.["details"];
  if (Array.isArray(details)) {
    for (const detail of details) {
      const code = record(detail)?.["errorCode"];
      if (typeof code === "string") {
        fcmCode = code;
        break;
      }
    }
  }
  const googleStatus = typeof error?.["status"] === "string" ? error["status"] : null;
  const message = typeof error?.["message"] === "string" ? error["message"] : null;
  return {
    reason: (fcmCode ?? googleStatus ?? message ?? statusText) || null,
    tokenGone: status === 404 || fcmCode === "UNREGISTERED" || fcmCode === "INVALID_ARGUMENT",
  };
}

/** Firebase Cloud Messaging HTTP v1 client authenticated with a service-account JWT. */
export class FcmClient {
  private oauthToken: { value: string; mintedAt: number } | null = null;

  constructor(
    private env: ServerEnv,
    private fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  configured(): boolean {
    return Boolean(this.env.FCM_PROJECT_ID && this.env.FCM_CLIENT_EMAIL && this.env.FCM_PRIVATE_KEY);
  }

  private async accessToken(): Promise<string> {
    if (this.oauthToken && Date.now() - this.oauthToken.mintedAt < ACCESS_TOKEN_TTL_MS) {
      return this.oauthToken.value;
    }

    const now = Math.floor(Date.now() / 1000);
    const privateKey = this.env.FCM_PRIVATE_KEY!.replace(/\\n/g, "\n");
    const key = await importPKCS8(privateKey, "RS256");
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.env.FCM_CLIENT_EMAIL!)
      .setAudience(OAUTH_TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 60 * 60)
      .sign(key);

    const response = await this.fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    const accessToken = record(body)?.["access_token"];
    if (!response.ok || typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error("oauth_token_failed");
    }
    this.oauthToken = { value: accessToken, mintedAt: Date.now() };
    return accessToken;
  }

  async send(token: string, payload: PushPayload): Promise<FcmResult> {
    try {
      const accessToken = await this.accessToken();
      const response = await this.fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.env.FCM_PROJECT_ID!)}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(fcmMessage(token, payload)),
        },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.ok) {
        return { ok: true, status: response.status, reason: null, tokenGone: false };
      }
      const failure = fcmFailure(body, response.status, response.statusText);
      return { ok: false, status: response.status, ...failure };
    } catch {
      return { ok: false, status: 0, reason: "request_failed", tokenGone: false };
    }
  }
}
