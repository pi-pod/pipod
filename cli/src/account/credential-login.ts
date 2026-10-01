import WebSocket, { type RawData } from "ws";
import { CancelledError, PiPodError } from "../errors.js";
import type {
  RemoteAuthEvent,
  RemoteAuthInteraction,
  RemoteAuthPrompt,
  RemoteAuthType,
} from "../client/runtime/auth-bridge.js";
import {
  credentialProtocolError,
  type AccountClient,
  type CredentialStatus,
} from "./api.js";

export interface RunCredentialLoginOptions {
  client: AccountClient;
  providerId: string;
  authType: RemoteAuthType;
  podId?: string;
  interaction: RemoteAuthInteraction;
  createWebSocket?: (url: string) => WebSocket;
}

/** Run one provider-scoped account login over its one-shot WebSocket ticket. */
export async function runCredentialLogin(
  opts: RunCredentialLoginOptions,
): Promise<CredentialStatus> {
  if (opts.interaction.signal?.aborted) throw new CancelledError("Credential login cancelled");
  const ticket = await opts.client.createCredentialLoginTicket(opts.providerId, {
    authType: opts.authType,
    ...(opts.podId ? { podId: opts.podId } : {}),
  });
  const url = opts.client.credentialLoginWsUrl(opts.providerId, ticket.ticket);
  let socket: WebSocket;
  try {
    socket = (opts.createWebSocket ?? ((target) => new WebSocket(target)))(url);
  } catch (error) {
    throw new PiPodError(`could not open the ${opts.providerId} credential login`, {
      cause: error,
      transient: true,
    });
  }

  return new Promise<CredentialStatus>((resolve, reject) => {
    let settled = false;
    let completed = false;
    let processing = Promise.resolve();

    const cleanup = (): void => {
      opts.interaction.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (outcome: { status: CredentialStatus } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("status" in outcome) resolve(outcome.status);
      else reject(outcome.error);
    };
    const closeSocket = (): void => {
      try {
        socket.close();
      } catch {
        // A socket that failed while connecting is already unusable.
      }
    };
    const sendCancel = (): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: "cancel" }));
      } catch {
        // Closing the socket has the same cancellation semantics.
      }
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      sendCancel();
      finish({ error: error instanceof Error ? error : new PiPodError(String(error)) });
      closeSocket();
    };
    const onAbort = (): void => {
      if (settled) return;
      sendCancel();
      finish({ error: new CancelledError("Credential login cancelled") });
      closeSocket();
    };

    const handleFrame = async (raw: RawData): Promise<void> => {
      if (settled) return;
      const frame = parseFrame(raw);
      if (frame.type === "prompt") {
        const prompt: RemoteAuthPrompt = {
          ...frame.prompt,
          ...(opts.interaction.signal ? { signal: opts.interaction.signal } : {}),
        };
        const value = await opts.interaction.prompt(prompt);
        if (settled) return;
        socket.send(JSON.stringify({ type: "response", id: frame.id, value }));
        return;
      }
      if (frame.type === "event") {
        // Match the in-pod auth bridge: unsafe URL-bearing events are consumed, never shown.
        if (frame.event) opts.interaction.notify(frame.event);
        return;
      }
      completed = true;
      if (frame.ok) {
        finish({ status: frame.status });
      } else {
        finish({
          error: frame.error.code === "cancelled"
            ? new CancelledError(frame.error.message ?? "Credential login cancelled")
            : credentialProtocolError(
                frame.error.code,
                frame.error.message,
                opts.providerId,
              ),
        });
      }
      closeSocket();
    };

    socket.on("message", (raw) => {
      processing = processing.then(() => handleFrame(raw)).catch(fail);
    });
    socket.on("error", (error) => {
      fail(new PiPodError(`the ${opts.providerId} credential login connection failed`, {
        cause: error,
        transient: true,
      }));
    });
    socket.on("close", (code) => {
      void processing.finally(() => {
        if (!settled && !completed) {
          fail(new PiPodError(
            code === 4001
              ? "the credential login ticket was invalid or expired"
              : `the ${opts.providerId} credential login closed before it completed`,
            { transient: code !== 4001 },
          ));
        }
      });
    });

    if (opts.interaction.signal?.aborted) onAbort();
    else opts.interaction.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type LoginFrame =
  | { type: "prompt"; id: string; prompt: RemoteAuthPrompt }
  | { type: "event"; event: RemoteAuthEvent | null }
  | { type: "done"; ok: true; status: CredentialStatus }
  | { type: "done"; ok: false; error: { code: string; message?: string } };

function parseFrame(raw: RawData): LoginFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    throw new PiPodError("the credential login server sent invalid JSON");
  }
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new PiPodError("the credential login server sent an invalid frame");
  }
  if (value["type"] === "prompt") {
    if (typeof value["id"] !== "string") throw new PiPodError("the credential login server sent an invalid prompt id");
    return { type: "prompt", id: value["id"], prompt: parsePrompt(value["prompt"]) };
  }
  if (value["type"] === "event") {
    return { type: "event", event: parseEvent(value["event"]) };
  }
  if (value["type"] === "done") {
    if (value["ok"] === true) {
      return { type: "done", ok: true, status: parseCredentialStatus(value["status"]) };
    }
    if (value["ok"] === false && isRecord(value["error"]) && typeof value["error"]["code"] === "string") {
      const message = value["error"]["message"];
      if (message !== undefined && typeof message !== "string") {
        throw new PiPodError("the credential login server sent an invalid error");
      }
      return {
        type: "done",
        ok: false,
        error: {
          code: value["error"]["code"],
          ...(typeof message === "string" ? { message } : {}),
        },
      };
    }
  }
  throw new PiPodError("the credential login server sent an invalid frame");
}

function parsePrompt(value: unknown): RemoteAuthPrompt {
  if (!isRecord(value) || !["text", "secret", "manual_code", "select"].includes(String(value["type"])) || typeof value["message"] !== "string") {
    throw new PiPodError("the credential login server sent an invalid prompt");
  }
  if (value["placeholder"] !== undefined && typeof value["placeholder"] !== "string") {
    throw new PiPodError("the credential login server sent an invalid prompt placeholder");
  }
  const type = value["type"] as RemoteAuthPrompt["type"];
  if (type === "select") {
    if (!Array.isArray(value["options"])) throw new PiPodError("the credential login server sent invalid select options");
    const options = value["options"].map((option) => {
      if (!isRecord(option) || typeof option["id"] !== "string" || typeof option["label"] !== "string" || (option["description"] !== undefined && typeof option["description"] !== "string")) {
        throw new PiPodError("the credential login server sent invalid select options");
      }
      return {
        id: option["id"],
        label: option["label"],
        ...(typeof option["description"] === "string" ? { description: option["description"] } : {}),
      };
    });
    return { type, message: value["message"], options };
  }
  return {
    type,
    message: value["message"],
    ...(typeof value["placeholder"] === "string" ? { placeholder: value["placeholder"] } : {}),
  };
}

function parseEvent(value: unknown): RemoteAuthEvent | null {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new PiPodError("the credential login server sent an invalid event");
  }
  if (value["type"] === "auth_url") {
    if (!isSafeAuthUrl(value["url"])) return null;
    if (value["instructions"] !== undefined && typeof value["instructions"] !== "string") throw new PiPodError("the credential login server sent invalid instructions");
    return {
      type: "auth_url",
      url: value["url"],
      ...(typeof value["instructions"] === "string" ? { instructions: value["instructions"] } : {}),
    };
  }
  if (value["type"] === "device_code") {
    if (typeof value["userCode"] !== "string" || !isSafeAuthUrl(value["verificationUri"])) return null;
    if (value["intervalSeconds"] !== undefined && typeof value["intervalSeconds"] !== "number") throw new PiPodError("the credential login server sent an invalid device code");
    if (value["expiresInSeconds"] !== undefined && typeof value["expiresInSeconds"] !== "number") throw new PiPodError("the credential login server sent an invalid device code");
    return {
      type: "device_code",
      userCode: value["userCode"],
      verificationUri: value["verificationUri"],
      ...(typeof value["intervalSeconds"] === "number" ? { intervalSeconds: value["intervalSeconds"] } : {}),
      ...(typeof value["expiresInSeconds"] === "number" ? { expiresInSeconds: value["expiresInSeconds"] } : {}),
    };
  }
  if (value["type"] === "info") {
    if (typeof value["message"] !== "string") throw new PiPodError("the credential login server sent an invalid info event");
    if (value["links"] === undefined) return { type: "info", message: value["message"] };
    if (!Array.isArray(value["links"])) throw new PiPodError("the credential login server sent invalid links");
    const links: Array<{ url: string; label?: string }> = [];
    for (const link of value["links"]) {
      if (!isRecord(link) || (link["label"] !== undefined && typeof link["label"] !== "string")) throw new PiPodError("the credential login server sent invalid links");
      if (!isSafeAuthUrl(link["url"])) return null;
      links.push({
        url: link["url"],
        ...(typeof link["label"] === "string" ? { label: link["label"] } : {}),
      });
    }
    return { type: "info", message: value["message"], links };
  }
  if (value["type"] === "progress" && typeof value["message"] === "string") {
    return { type: "progress", message: value["message"] };
  }
  throw new PiPodError("the credential login server sent an invalid event");
}

function parseCredentialStatus(value: unknown): CredentialStatus {
  if (!isRecord(value) || typeof value["providerId"] !== "string" || (value["type"] !== "oauth" && value["type"] !== "api_key") || typeof value["revision"] !== "number") {
    throw new PiPodError("the credential login server sent an invalid credential status");
  }
  const base: Pick<CredentialStatus, "providerId" | "type" | "revision"> = {
    providerId: value["providerId"],
    type: value["type"],
    revision: value["revision"],
  };
  if (value["state"] === "ready") {
    if ((value["expiresAt"] !== undefined && typeof value["expiresAt"] !== "string") || (value["lastRefreshAt"] !== undefined && typeof value["lastRefreshAt"] !== "string")) throw new PiPodError("the credential login server sent an invalid ready status");
    return {
      ...base,
      state: "ready",
      ...(typeof value["expiresAt"] === "string" ? { expiresAt: value["expiresAt"] } : {}),
      ...(typeof value["lastRefreshAt"] === "string" ? { lastRefreshAt: value["lastRefreshAt"] } : {}),
    };
  }
  if (value["state"] === "reconnect_required" && ["revoked", "invalid_grant", "missing_refresh_token", "migration_required"].includes(String(value["reason"]))) {
    return { ...base, state: "reconnect_required", reason: value["reason"] as "revoked" | "invalid_grant" | "missing_refresh_token" | "migration_required" };
  }
  if (value["state"] === "temporarily_unavailable") {
    if (value["retryAfter"] !== undefined && typeof value["retryAfter"] !== "string") throw new PiPodError("the credential login server sent an invalid temporary status");
    return {
      ...base,
      state: "temporarily_unavailable",
      ...(typeof value["retryAfter"] === "string" ? { retryAfter: value["retryAfter"] } : {}),
    };
  }
  throw new PiPodError("the credential login server sent an invalid credential status");
}

function isSafeAuthUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]"));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
