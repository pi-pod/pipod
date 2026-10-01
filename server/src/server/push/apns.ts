import * as http2 from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import type { ServerEnv } from "../env.js";
import type { PushPayload } from "./queue.js";

const TOKEN_TTL_MS = 50 * 60 * 1000;

export interface ApnsResult {
  ok: boolean;
  status: number;
  reason: string | null;
  /** APNs says this token is dead — prune the device row. */
  tokenGone: boolean;
}

/** Token-based APNs auth over HTTP/2 (spec §11) — no third-party push service in the loop. */
export class ApnsClient {
  private jwt: { value: string; mintedAt: number } | null = null;

  constructor(private env: ServerEnv) {}

  configured(): boolean {
    return Boolean(this.env.APNS_TEAM_ID && this.env.APNS_KEY_ID && this.env.APNS_KEY_P8 && this.env.APNS_BUNDLE_ID);
  }

  private async token(): Promise<string> {
    if (this.jwt && Date.now() - this.jwt.mintedAt < TOKEN_TTL_MS) return this.jwt.value;
    const key = await importPKCS8(this.env.APNS_KEY_P8!, "ES256");
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.env.APNS_KEY_ID! })
      .setIssuer(this.env.APNS_TEAM_ID!)
      .setIssuedAt()
      .sign(key);
    this.jwt = { value, mintedAt: Date.now() };
    return value;
  }

  async send(deviceToken: string, environment: string, payload: PushPayload): Promise<ApnsResult> {
    const host =
      environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    const jwt = await this.token();
    const notificationTarget = payload.data.pod_id ?? payload.data.job_id ?? "pi-pod";
    const body = JSON.stringify({
      aps: {
        alert: { title: payload.title, ...(payload.body ? { body: payload.body } : {}) },
        sound: "default",
        "interruption-level": payload.interruptionLevel ?? "active",
        // Group a pod's notifications into one lock-screen thread instead of a stack.
        "thread-id": notificationTarget,
      },
      ...payload.data,
    });

    return new Promise<ApnsResult>((resolve) => {
      const session = http2.connect(host);
      session.on("error", () => resolve({ ok: false, status: 0, reason: "connect_failed", tokenGone: false }));
      const stream = session.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": this.env.APNS_BUNDLE_ID!,
        "apns-push-type": "alert",
        // Newer state replaces older for the same (pod, kind) rather than piling up.
        "apns-collapse-id": `${notificationTarget}:${payload.data.kind}`.slice(0, 64),
        "content-type": "application/json",
      });
      let status = 0;
      let data = "";
      stream.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      stream.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
      stream.on("end", () => {
        session.close();
        let reason: string | null = null;
        try {
          reason = data ? (JSON.parse(data) as { reason?: string }).reason ?? null : null;
        } catch {
          reason = data || null;
        }
        resolve({
          ok: status === 200,
          status,
          reason,
          tokenGone: status === 410 || reason === "BadDeviceToken" || reason === "Unregistered",
        });
      });
      stream.on("error", () => {
        session.close();
        resolve({ ok: false, status: 0, reason: "stream_error", tokenGone: false });
      });
      stream.end(body);
    });
  }
}
