import { randomUUID } from "node:crypto";
import type { RpcClientBase } from "../rpc.js";
import {
  AUTH_BRIDGE_COMMAND,
  AUTH_BRIDGE_DIALOG_PREFIX,
  AUTH_BRIDGE_MAX_ENCODED_RESPONSE_BYTES,
  AUTH_BRIDGE_MAX_PROVIDER_ID_LENGTH,
  AUTH_BRIDGE_NOTIFICATION_PREFIX,
  AUTH_BRIDGE_PROTOCOL_VERSION,
  TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES,
  TREE_BRIDGE_MAX_ID_LENGTH,
} from "../../shim/pi-pod-ext.js";
import { decodeWireJson, encodeWireJson, isBoundedString, isPlainObject } from "../../wire-codec.js";

export type RemoteAuthType = "oauth" | "api_key";

export interface RemoteAuthPrompt {
  type: "text" | "secret" | "manual_code" | "select";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  signal?: AbortSignal;
}

export type RemoteAuthEvent =
  | { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export interface RemoteAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: RemoteAuthPrompt): Promise<string>;
  notify(event: RemoteAuthEvent): void;
}

export interface RemoteProviderSnapshot {
  id: string;
  name: string;
  auth: {
    apiKey?: { name: string; interactive: boolean };
    oauth?: { name: string; loginLabel?: string };
  };
  status: { configured: boolean; source?: string; label?: string };
  usingOAuth: boolean;
}

export interface RemoteAuthSnapshot {
  providers: RemoteProviderSnapshot[];
  credentials: Array<{ providerId: string; type: RemoteAuthType }>;
}

interface ExtensionUiRequest {
  type?: unknown;
  id?: unknown;
  method?: unknown;
  title?: unknown;
  message?: unknown;
}

type AuthOperation = "providers" | "login" | "logout";

type AuthRequest =
  | { v: 1; id: string; op: "providers" }
  | { v: 1; id: string; op: "login"; providerId: string; authType: RemoteAuthType }
  | { v: 1; id: string; op: "logout"; providerId: string };

interface PendingAuthRequest {
  op: AuthOperation;
  interaction?: RemoteAuthInteraction;
  resolve(snapshot: RemoteAuthSnapshot): void;
  reject(error: Error): void;
  cleanup(): void;
  cancelRequestId?: string;
}

export interface AuthBridgeOptions {
  getCommands: () => unknown[];
  timeoutMs?: number;
}

const AUTH_BRIDGE_TIMEOUT_MS = 15_000;

export class AuthBridgeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AuthBridgeError";
  }
}

export function supportsAuthBridge(commands: unknown[]): boolean {
  return commands.some((command) => {
    const candidate = command as { name?: unknown; source?: unknown };
    return candidate.name === AUTH_BRIDGE_COMMAND && candidate.source === "extension";
  });
}

/** Relays Pi's native LoginDialog interaction to the authoritative pod ModelRuntime. */
export class AuthBridge {
  private readonly pending = new Map<string, PendingAuthRequest>();
  private disposedError: Error | null = null;
  private readonly unwireLifecycle: () => void;
  private readonly timeoutMs: number;
  snapshot: RemoteAuthSnapshot = { providers: [], credentials: [] };

  constructor(
    private readonly rpc: RpcClientBase,
    private readonly options: AuthBridgeOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? AUTH_BRIDGE_TIMEOUT_MS;
    this.unwireLifecycle = rpc.onLifecycleInvalidated((error) => this.failAll(error));
  }

  supportsAuthBridge(commands: unknown[] = this.options.getCommands()): boolean {
    return supportsAuthBridge(commands);
  }

  async refresh(): Promise<RemoteAuthSnapshot> {
    if (!this.supportsAuthBridge()) return this.snapshot;
    return this.invoke({ op: "providers" });
  }

  login(providerId: string, authType: RemoteAuthType, interaction: RemoteAuthInteraction): Promise<RemoteAuthSnapshot> {
    validateProviderId(providerId);
    return this.invoke({ op: "login", providerId, authType }, interaction);
  }

  logout(providerId: string): Promise<RemoteAuthSnapshot> {
    validateProviderId(providerId);
    return this.invoke({ op: "logout", providerId });
  }

  /** Consume reserved auth notifications and dialogs before the generic extension UI sees them. */
  consumeExtensionRequest(request: ExtensionUiRequest): boolean {
    if (request.type !== "extension_ui_request") return false;

    if (request.method === "notify" && typeof request.message === "string" && request.message.startsWith(AUTH_BRIDGE_NOTIFICATION_PREFIX)) {
      let message: unknown;
      try {
        message = decodeWire(request.message.slice(AUTH_BRIDGE_NOTIFICATION_PREFIX.length));
        this.consumeNotification(message);
      } catch (error) {
        const id = isPlainObject(message) && typeof message.id === "string" ? message.id : undefined;
        if (id) this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        // Uncorrelated malformed reserved traffic is consumed rather than shown in the UI.
      }
      return true;
    }

    if (typeof request.title !== "string" || !request.title.startsWith(AUTH_BRIDGE_DIALOG_PREFIX)) return false;
    const extensionRequestId = typeof request.id === "string" ? request.id : "";
    try {
      const message = decodeWire(request.title.slice(AUTH_BRIDGE_DIALOG_PREFIX.length));
      this.consumeDialog(extensionRequestId, request.method, message);
    } catch {
      if (extensionRequestId) this.rpc.respondExtensionUi({ type: "extension_ui_response", id: extensionRequestId, cancelled: true });
    }
    return true;
  }

  dispose(error = new Error("auth bridge was disposed")): void {
    if (this.disposedError) return;
    this.disposedError = error;
    this.unwireLifecycle();
    this.failAll(error);
  }

  private consumeNotification(value: unknown): void {
    if (!isPlainObject(value) || value.v !== AUTH_BRIDGE_PROTOCOL_VERSION || !isBoundedString(value.id, TREE_BRIDGE_MAX_ID_LENGTH)) return;
    const waiter = this.pending.get(value.id);
    if (value.kind === "event") {
      if (waiter?.interaction && isAuthEvent(value.event)) waiter.interaction.notify(value.event);
      return;
    }
    if (value.kind !== "response" || !isAuthOperation(value.op) || typeof value.ok !== "boolean") {
      waiter?.reject(new AuthBridgeError("invalid auth bridge response", "invalid_response"));
      return;
    }
    if (!waiter) return;
    if (waiter.op !== value.op) {
      waiter.reject(new AuthBridgeError("auth bridge response operation did not match its request", "invalid_response"));
      return;
    }
    if (!value.ok) {
      const error = isPlainObject(value.error) ? value.error : {};
      waiter.reject(new AuthBridgeError(typeof error.message === "string" ? error.message : "pod authentication failed", typeof error.code === "string" ? error.code : "operation_failed"));
      return;
    }
    const snapshot = validateSnapshot(value.data);
    this.snapshot = snapshot;
    waiter.resolve(snapshot);
  }

  private consumeDialog(extensionRequestId: string, method: unknown, value: unknown): void {
    if (!extensionRequestId || !isPlainObject(value) || value.v !== AUTH_BRIDGE_PROTOCOL_VERSION || !isBoundedString(value.id, TREE_BRIDGE_MAX_ID_LENGTH)) {
      if (extensionRequestId) this.rpc.respondExtensionUi({ type: "extension_ui_response", id: extensionRequestId, cancelled: true });
      return;
    }
    const waiter = this.pending.get(value.id);
    if (value.kind === "cancel" && method === "confirm") {
      const signal = waiter?.interaction?.signal;
      if (!waiter || signal?.aborted) {
        this.rpc.respondExtensionUi({ type: "extension_ui_response", id: extensionRequestId, confirmed: true });
      } else if (signal) {
        waiter.cancelRequestId = extensionRequestId;
      }
      // With no signal this deliberately stays pending until the login completes pod-side;
      // its AbortController then removes the RPC dialog without requiring a response.
      return;
    }
    if (value.kind !== "prompt" || (method !== "input" && method !== "select") || !waiter?.interaction) {
      this.rpc.respondExtensionUi({ type: "extension_ui_response", id: extensionRequestId, cancelled: true });
      return;
    }
    let prompt: RemoteAuthPrompt;
    try {
      prompt = validatePrompt(value.prompt);
    } catch {
      this.rpc.respondExtensionUi({ type: "extension_ui_response", id: extensionRequestId, cancelled: true });
      return;
    }
    if (waiter.interaction.signal) prompt.signal = waiter.interaction.signal;
    void waiter.interaction.prompt(prompt).then(
      (answer) => {
        const wireAnswer = answer;
        if (wireAnswer === undefined) this.rpc.respondExtensionUi({ type: "extension_ui_response", id: extensionRequestId, cancelled: true });
        else this.rpc.respondExtensionUi({ type: "extension_ui_response", id: extensionRequestId, value: wireAnswer });
      },
      () => this.rpc.respondExtensionUi({ type: "extension_ui_response", id: extensionRequestId, cancelled: true }),
    );
  }

  private invoke(
    request: Omit<Extract<AuthRequest, { op: "providers" }>, "v" | "id"> | Omit<Extract<AuthRequest, { op: "login" }>, "v" | "id"> | Omit<Extract<AuthRequest, { op: "logout" }>, "v" | "id">,
    interaction?: RemoteAuthInteraction,
  ): Promise<RemoteAuthSnapshot> {
    if (this.disposedError) return Promise.reject(this.disposedError);
    if (!this.supportsAuthBridge()) {
      return Promise.reject(new AuthBridgeError(
        "This running pod uses an older pi-pod extension. Exit Pi, then attach again before using /login.",
        "auth_bridge_unavailable",
      ));
    }
    const id = randomUUID();
    const envelope = { v: AUTH_BRIDGE_PROTOCOL_VERSION, id, ...request } as AuthRequest;
    const encoded = encodeWireJson(envelope);
    if (Buffer.byteLength(encoded, "utf8") > TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES) {
      return Promise.reject(new AuthBridgeError("auth bridge request exceeded the configured limit", "payload_too_large"));
    }

    return new Promise<RemoteAuthSnapshot>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const onAbort = () => {
        const cancelRequestId = this.pending.get(id)?.cancelRequestId;
        if (cancelRequestId) {
          this.rpc.respondExtensionUi({ type: "extension_ui_response", id: cancelRequestId, confirmed: true });
        }
        finish({ error: new AuthBridgeError("Login cancelled", "cancelled") });
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        this.pending.delete(id);
        interaction?.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (outcome: { snapshot: RemoteAuthSnapshot } | { error: Error }) => {
        if (settled) return;
        settled = true;
        cleanup();
        if ("snapshot" in outcome) resolve(outcome.snapshot);
        else reject(outcome.error);
      };
      this.pending.set(id, {
        op: request.op,
        interaction,
        resolve: (snapshot) => finish({ snapshot }),
        reject: (error) => finish({ error }),
        cleanup,
      });
      if (interaction?.signal?.aborted) return onAbort();
      interaction?.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.op !== "login") {
        timer = setTimeout(() => {
          finish({ error: new AuthBridgeError(`auth bridge ${request.op} timed out after ${this.timeoutMs}ms`, "timeout") });
        }, this.timeoutMs);
      }
      this.rpc.prompt(
        `/${AUTH_BRIDGE_COMMAND} ${encoded}`,
        undefined,
        interaction?.signal ? { signal: interaction.signal } : undefined,
      ).catch((error) => {
        finish({ error: error instanceof Error ? error : new Error(String(error)) });
      });
    });
  }

  private failAll(error: Error): void {
    for (const waiter of [...this.pending.values()]) waiter.reject(error);
  }
}

function validateProviderId(value: string): void {
  if (!isBoundedString(value, AUTH_BRIDGE_MAX_PROVIDER_ID_LENGTH)) throw new AuthBridgeError("invalid provider id", "invalid_provider");
}

function decodeWire(encoded: string): unknown {
  const decoded = decodeWireJson(encoded, AUTH_BRIDGE_MAX_ENCODED_RESPONSE_BYTES);
  if (!decoded.ok) {
    if (decoded.reason === "non_canonical") {
      throw new AuthBridgeError("non-canonical auth bridge message", "invalid_response");
    }
    if (decoded.reason === "invalid_utf8_json") {
      throw new AuthBridgeError("invalid auth bridge JSON", "invalid_response");
    }
    throw new AuthBridgeError("invalid auth bridge message", "invalid_response");
  }
  return decoded.value;
}

function validateSnapshot(value: unknown): RemoteAuthSnapshot {
  if (!isPlainObject(value) || !Array.isArray(value.providers) || !Array.isArray(value.credentials)) throw new AuthBridgeError("invalid provider snapshot", "invalid_response");
  const providers = value.providers.map((candidate) => {
    if (!isPlainObject(candidate) || !isBoundedString(candidate.id, AUTH_BRIDGE_MAX_PROVIDER_ID_LENGTH) || typeof candidate.name !== "string" || !isPlainObject(candidate.auth) || !isPlainObject(candidate.status) || typeof candidate.status.configured !== "boolean" || typeof candidate.usingOAuth !== "boolean") {
      throw new AuthBridgeError("invalid provider metadata", "invalid_response");
    }
    const auth: RemoteProviderSnapshot["auth"] = {};
    if (candidate.auth.apiKey !== undefined) {
      if (!isPlainObject(candidate.auth.apiKey) || typeof candidate.auth.apiKey.name !== "string" || typeof candidate.auth.apiKey.interactive !== "boolean") throw new AuthBridgeError("invalid API key metadata", "invalid_response");
      auth.apiKey = { name: candidate.auth.apiKey.name, interactive: candidate.auth.apiKey.interactive };
    }
    if (candidate.auth.oauth !== undefined) {
      if (!isPlainObject(candidate.auth.oauth) || typeof candidate.auth.oauth.name !== "string" || (candidate.auth.oauth.loginLabel !== undefined && typeof candidate.auth.oauth.loginLabel !== "string")) throw new AuthBridgeError("invalid OAuth metadata", "invalid_response");
      auth.oauth = { name: candidate.auth.oauth.name, ...(candidate.auth.oauth.loginLabel ? { loginLabel: candidate.auth.oauth.loginLabel } : {}) };
    }
    return {
      id: candidate.id,
      name: candidate.name,
      auth,
      status: {
        configured: candidate.status.configured,
        ...(typeof candidate.status.source === "string" ? { source: candidate.status.source } : {}),
        ...(typeof candidate.status.label === "string" ? { label: candidate.status.label } : {}),
      },
      usingOAuth: candidate.usingOAuth,
    };
  });
  const credentials = value.credentials.map((candidate) => {
    if (!isPlainObject(candidate) || !isBoundedString(candidate.providerId, AUTH_BRIDGE_MAX_PROVIDER_ID_LENGTH) || (candidate.type !== "oauth" && candidate.type !== "api_key")) throw new AuthBridgeError("invalid credential metadata", "invalid_response");
    return { providerId: candidate.providerId, type: candidate.type as RemoteAuthType };
  });
  return { providers, credentials };
}

function validatePrompt(value: unknown): RemoteAuthPrompt {
  if (!isPlainObject(value) || !["text", "secret", "manual_code", "select"].includes(String(value.type)) || typeof value.message !== "string" || (value.placeholder !== undefined && typeof value.placeholder !== "string")) throw new AuthBridgeError("invalid auth prompt", "invalid_response");
  const type = value.type as RemoteAuthPrompt["type"];
  if (type === "select") {
    if (!Array.isArray(value.options)) throw new AuthBridgeError("invalid auth options", "invalid_response");
    const options = value.options.map((option) => {
      if (!isPlainObject(option) || typeof option.id !== "string" || typeof option.label !== "string" || (option.description !== undefined && typeof option.description !== "string")) throw new AuthBridgeError("invalid auth option", "invalid_response");
      return { id: option.id, label: option.label, ...(option.description ? { description: option.description } : {}) };
    });
    return { type, message: value.message, options };
  }
  return { type, message: value.message, ...(typeof value.placeholder === "string" ? { placeholder: value.placeholder } : {}) };
}

function isAuthEvent(value: unknown): value is RemoteAuthEvent {
  if (!isPlainObject(value) || typeof value.type !== "string") return false;
  if (value.type === "auth_url") {
    return isSafeAuthUrl(value.url) && (value.instructions === undefined || typeof value.instructions === "string");
  }
  if (value.type === "device_code") {
    return typeof value.userCode === "string" && isSafeAuthUrl(value.verificationUri);
  }
  if (value.type === "info") {
    return typeof value.message === "string" && (
      value.links === undefined || (
        Array.isArray(value.links) && value.links.every((link) =>
          isPlainObject(link) && isSafeAuthUrl(link.url) && (link.label === undefined || typeof link.label === "string"),
        )
      )
    );
  }
  return value.type === "progress" && typeof value.message === "string";
}

function isSafeAuthUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"));
  } catch {
    return false;
  }
}

function isAuthOperation(value: unknown): value is AuthOperation {
  return value === "providers" || value === "login" || value === "logout";
}

