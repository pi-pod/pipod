import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RpcClientBase, ThinkingLevel } from "../../core/client/rpc.js";
import {
  AUX_BRIDGE_PROTOCOL_VERSION,
  AUX_CANCEL_COMMAND,
  AUX_COMPLETE_COMMAND,
  AUX_CONCURRENCY_LIMIT,
  AUX_MAX_ENCODED_REQUEST_BYTES,
  AUX_MAX_ENCODED_RESPONSE_BYTES,
  AUX_NOTIFICATION_PREFIX,
  FILE_LIST_COMMAND,
  FILE_LIST_NOTIFICATION_PREFIX,
  FILE_LIST_PROTOCOL_VERSION,
  POD_EXTENSION_VERSION,
  SESSION_CATALOG_MAX_ENCODED_RESPONSE_BYTES,
  SESSION_CATALOG_PROTOCOL_VERSION,
  SESSION_LIST_CHUNKED_COMMAND,
  SESSION_LIST_CHUNK_NOTIFICATION_PREFIX,
  SESSION_LIST_NOTIFICATION_PREFIX,
  SESSION_SEARCH_COMMAND,
  SESSION_SEARCH_NOTIFICATION_PREFIX,
  TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES,
  TREE_BRIDGE_MAX_ID_LENGTH,
  SEED_CHUNK_MAX_CHUNKS,
  SEED_CHUNK_MAX_JSON_BYTES,
  SEED_CHUNK_MAX_PART_CHARS,
} from "../../core/shim/pi-pod-ext.js";
import { decodeWireJson, encodeWireJson, isBoundedString, isPlainObject } from "../../core/wire-codec.js";
import type { PodSessionService } from "./session-services.js";

/** Catalog/search are filesystem reads but may traverse many bounded session files. */
export const SESSION_EXTENSION_TIMEOUT_MS = 15_000;

type SessionExtensionOperation = "list-sessions" | "search-sessions" | "list-files";

/** Completion answers a keystroke; a late reply is worthless, so it gets its own budget. */
export const FILE_LIST_EXTENSION_TIMEOUT_MS = 2_000;

type SessionExtensionEnvelope = {
  v: 1;
  id: string;
  op: SessionExtensionOperation;
  ok: boolean;
  data?: unknown;
  error?: { code?: unknown; message?: unknown };
};

/** Reserved extension traffic never becomes transcript/UI traffic, even when malformed or stale. */
export function isSessionExtensionEvent(event: unknown): boolean {
  const candidate = event as { type?: unknown; method?: unknown; message?: unknown };
  if (candidate.type !== "extension_ui_request" || typeof candidate.message !== "string") return false;
  return (
    candidate.message.startsWith(SESSION_LIST_NOTIFICATION_PREFIX) ||
    candidate.message.startsWith(SESSION_LIST_CHUNK_NOTIFICATION_PREFIX) ||
    candidate.message.startsWith(SESSION_SEARCH_NOTIFICATION_PREFIX) ||
    candidate.message.startsWith(FILE_LIST_NOTIFICATION_PREFIX) ||
    candidate.message.startsWith(AUX_NOTIFICATION_PREFIX)
  );
}

function extensionUnavailable(rpc: RpcClientBase): Error | null {
  const version = rpc.helloInfo?.extensionVersion;
  if (typeof version === "number" && version >= POD_EXTENSION_VERSION) return null;
  return new Error(`the running pod does not expose session catalog extension v${POD_EXTENSION_VERSION}`);
}

function validateEnvelope(value: unknown, id: string, op: SessionExtensionOperation): SessionExtensionEnvelope {
  if (!isPlainObject(value)) throw new Error("session extension response must be an object");
  const version = op === "list-files" ? FILE_LIST_PROTOCOL_VERSION : SESSION_CATALOG_PROTOCOL_VERSION;
  if (value.v !== version || value.id !== id || value.op !== op || typeof value.ok !== "boolean") {
    throw new Error("session extension response did not match its request");
  }
  const envelope = value as unknown as SessionExtensionEnvelope;
  if (!envelope.ok) {
    const message = isPlainObject(envelope.error) && typeof envelope.error.message === "string"
      ? envelope.error.message
      : "session extension operation failed";
    throw new Error(message);
  }
  return envelope;
}

function decodePlain(encoded: string): unknown {
  const decoded = decodeWireJson(encoded, SESSION_CATALOG_MAX_ENCODED_RESPONSE_BYTES);
  if (!decoded.ok) throw new Error("invalid session extension response encoding");
  return decoded.value;
}

function decodeChunks(encoded: string, encoding: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) {
    throw new Error("invalid session extension chunk encoding");
  }
  const bytes = Buffer.from(encoded, "base64url");
  const json = encoding === "gz"
    ? gunzipSync(bytes, { maxOutputLength: SEED_CHUNK_MAX_JSON_BYTES }).toString("utf8")
    : bytes.toString("utf8");
  if (Buffer.byteLength(json, "utf8") > SEED_CHUNK_MAX_JSON_BYTES) {
    throw new Error("session extension response exceeded the decoded limit");
  }
  return JSON.parse(json) as unknown;
}

async function invokeSessionExtension(
  rpc: RpcClientBase,
  request:
    | { op: "list-sessions" }
    | { op: "search-sessions"; text: string; limit: number }
    | { op: "list-files"; query: string },
): Promise<unknown> {
  const unavailable = extensionUnavailable(rpc);
  if (unavailable) throw unavailable;
  const id = randomUUID();
  if (!isBoundedString(id, TREE_BRIDGE_MAX_ID_LENGTH)) throw new Error("invalid session extension request id");
  const version = request.op === "list-files" ? FILE_LIST_PROTOCOL_VERSION : SESSION_CATALOG_PROTOCOL_VERSION;
  const encodedRequest = encodeWireJson({ v: version, id, ...request });
  if (Buffer.byteLength(encodedRequest, "utf8") > TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES) {
    throw new Error("session extension request exceeded the configured limit");
  }
  const chunked = request.op === "list-sessions";
  const command = chunked
    ? SESSION_LIST_CHUNKED_COMMAND
    : request.op === "list-files" ? FILE_LIST_COMMAND : SESSION_SEARCH_COMMAND;
  const responsePrefix = chunked
    ? SESSION_LIST_CHUNK_NOTIFICATION_PREFIX
    : request.op === "list-files" ? FILE_LIST_NOTIFICATION_PREFIX : SESSION_SEARCH_NOTIFICATION_PREFIX;
  const timeoutMs = request.op === "list-files" ? FILE_LIST_EXTENSION_TIMEOUT_MS : SESSION_EXTENSION_TIMEOUT_MS;

  return new Promise<unknown>((resolve, reject) => {
    const abortController = new AbortController();
    let settled = false;
    let promptDone = false;
    let acknowledgement: unknown;
    let previousSeq = 0;
    let expectedTotal: number | null = null;
    let expectedEncoding: string | null = null;
    let encodedLength = 0;
    const parts: string[] = [];

    const finish = (outcome: { data: unknown } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offEvent();
      offLifecycle();
      if ("error" in outcome) {
        abortController.abort(outcome.error);
        reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)));
      } else {
        resolve(outcome.data);
      }
    };
    const maybeFinish = () => {
      if (promptDone && acknowledgement !== undefined) finish({ data: acknowledgement });
    };
    const accept = (candidate: unknown) => {
      const envelope = validateEnvelope(candidate, id, request.op);
      acknowledgement = envelope.data ?? null;
      maybeFinish();
    };
    const onEvent = (event: AgentSessionEvent) => {
      const candidate = event as { type?: unknown; method?: unknown; message?: unknown };
      if (candidate.type !== "extension_ui_request" || candidate.method !== "notify" || typeof candidate.message !== "string") return;
      if (!candidate.message.startsWith(responsePrefix)) return;
      try {
        const payload = candidate.message.slice(responsePrefix.length);
        if (!chunked) {
          const decoded = decodePlain(payload);
          if (isPlainObject(decoded) && decoded.id !== id) return;
          accept(decoded);
          return;
        }
        const fields = payload.split(" ");
        if (fields[0] !== id) return;
        if (fields.length !== 5) throw new Error("invalid session extension chunk header");
        const [, seqText, totalText, encoding, part] = fields;
        if (!/^[0-9]{1,7}$/.test(seqText!) || !/^[0-9]{1,7}$/.test(totalText!)) {
          throw new Error("invalid session extension chunk sequence");
        }
        const seq = Number(seqText);
        const total = Number(totalText);
        if (seq !== previousSeq + 1 || seq < 1 || seq > total || total > SEED_CHUNK_MAX_CHUNKS) {
          throw new Error("invalid session extension chunk sequence");
        }
        if (encoding !== "gz" && encoding !== "raw") throw new Error("invalid session extension chunk compression");
        if (expectedTotal !== null && expectedTotal !== total) throw new Error("session extension chunk total changed");
        if (expectedEncoding !== null && expectedEncoding !== encoding) throw new Error("session extension chunk compression changed");
        if (!part || part.length > SEED_CHUNK_MAX_PART_CHARS || !/^[A-Za-z0-9_-]+$/.test(part)) {
          throw new Error("invalid session extension chunk payload");
        }
        encodedLength += part.length;
        if (encodedLength > SESSION_CATALOG_MAX_ENCODED_RESPONSE_BYTES) {
          throw new Error("session extension chunk response exceeded the configured limit");
        }
        previousSeq = seq;
        expectedTotal = total;
        expectedEncoding = encoding;
        parts.push(part);
        if (seq === total) accept(decodeChunks(parts.join(""), encoding));
      } catch (error) {
        finish({ error });
      }
    };
    const offEvent = rpc.onEvent(onEvent);
    const offLifecycle = rpc.onLifecycleInvalidated((error) => finish({ error }));
    const timer = setTimeout(() => {
      finish({ error: new Error(`session extension ${request.op} timed out`) });
    }, timeoutMs);
    timer.unref?.();

    rpc.prompt(`/${command} ${encodedRequest}`, undefined, {
      signal: abortController.signal,
      timeoutMs,
    }).then(
      () => {
        promptDone = true;
        maybeFinish();
      },
      (error) => finish({ error }),
    );
  });
}

export const podSessionExtensionService: PodSessionService = {
  async list(rpc) {
    const data = await invokeSessionExtension(rpc, { op: "list-sessions" });
    if (!isPlainObject(data) || !Array.isArray(data.sessions) || typeof data.complete !== "boolean") {
      throw new Error("invalid session catalog data");
    }
    return { sessions: data.sessions, complete: data.complete };
  },
  async search(rpc, query) {
    const data = await invokeSessionExtension(rpc, { op: "search-sessions", ...query });
    if (!isPlainObject(data) || !Array.isArray(data.hits)) throw new Error("invalid session search data");
    return data.hits;
  },
  async listFiles(rpc, query) {
    const data = await invokeSessionExtension(rpc, { op: "list-files", query });
    if (!isPlainObject(data) || !Array.isArray(data.entries) || typeof data.complete !== "boolean") {
      throw new Error("invalid file list data");
    }
    return { entries: data.entries, complete: data.complete };
  },
};

/** Minimum extension version that serves auxiliary completions pod-side. */
export const AUX_MIN_EXTENSION_VERSION = 11;
/** Gateway-side per-session cap; mirrors the pod-side AUX_CONCURRENCY_LIMIT. */
export const AUX_GATEWAY_CONCURRENCY_LIMIT = AUX_CONCURRENCY_LIMIT;

export interface AuxCompleteMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AuxCompleteRequest {
  id: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  messages: AuxCompleteMessage[];
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AuxCompleteResult {
  id: string;
  ok: boolean;
  text?: string;
  stopReason?: string;
  usage?: unknown;
  code?: string;
  error?: string;
}

const AUX_THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function auxInvalid(id: string, message: string): AuxCompleteResult {
  return { id, ok: false, code: "invalid_request", error: message };
}

/**
 * Gateway-side validation for `aux_complete`. Failures become an ok:false result on the
 * asking sink — never the socket error channel, which cannot correlate them.
 */
export function validateAuxCompleteRequest(message: {
  id: unknown;
  provider: unknown;
  model: unknown;
  systemPrompt?: unknown;
  messages: unknown;
  thinkingLevel?: unknown;
  maxTokens?: unknown;
  timeoutMs?: unknown;
}): { request: AuxCompleteRequest } | { result: AuxCompleteResult } {
  const rawId = typeof message.id === "string" ? message.id : "";
  const fail = (error: string): { result: AuxCompleteResult } => ({
    result: auxInvalid(rawId !== "" ? rawId : "invalid", error),
  });
  if (typeof message.id !== "string" || message.id.length < 1 || message.id.length > 128) {
    return fail("aux id must be 1..128 chars");
  }
  if (typeof message.provider !== "string" || message.provider.length < 1 || message.provider.length > 128) {
    return fail("aux provider must be 1..128 chars");
  }
  if (typeof message.model !== "string" || message.model.length < 1 || message.model.length > 256) {
    return fail("aux model must be 1..256 chars");
  }
  if (
    message.systemPrompt !== undefined &&
    (typeof message.systemPrompt !== "string" || message.systemPrompt.length > 16384)
  ) {
    return fail("aux systemPrompt must be at most 16384 chars");
  }
  if (!Array.isArray(message.messages) || message.messages.length < 1 || message.messages.length > 16) {
    return fail("aux messages must hold 1..16 entries");
  }
  const messages: AuxCompleteMessage[] = [];
  for (const entry of message.messages) {
    if (!isPlainObject(entry) || (entry["role"] !== "user" && entry["role"] !== "assistant")) {
      return fail("aux message role must be user or assistant");
    }
    const content = entry["content"];
    if (typeof content !== "string" || content.length < 1 || content.length > 65536) {
      return fail("aux message content must be 1..65536 chars");
    }
    messages.push({ role: entry["role"], content });
  }
  let thinkingLevel: ThinkingLevel | undefined;
  if (message.thinkingLevel !== undefined) {
    if (typeof message.thinkingLevel !== "string" || !AUX_THINKING_LEVELS.includes(message.thinkingLevel)) {
      return fail("aux thinkingLevel is not a valid ThinkingLevel");
    }
    thinkingLevel = message.thinkingLevel as ThinkingLevel;
  }
  let maxTokens = 2048;
  if (message.maxTokens !== undefined) {
    if (
      typeof message.maxTokens !== "number" ||
      !Number.isInteger(message.maxTokens) ||
      message.maxTokens < 1 ||
      message.maxTokens > 4096
    ) {
      return fail("aux maxTokens must be 1..4096");
    }
    maxTokens = message.maxTokens;
  }
  let timeoutMs = 60000;
  if (message.timeoutMs !== undefined) {
    if (
      typeof message.timeoutMs !== "number" ||
      !Number.isFinite(message.timeoutMs) ||
      message.timeoutMs < 1000 ||
      message.timeoutMs > 120000
    ) {
      return fail("aux timeoutMs must be 1000..120000");
    }
    timeoutMs = message.timeoutMs;
  }
  return {
    request: {
      id: message.id,
      provider: message.provider,
      model: message.model,
      ...(typeof message.systemPrompt === "string" ? { systemPrompt: message.systemPrompt } : {}),
      messages,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      maxTokens,
      timeoutMs,
    },
  };
}

export function auxExtensionUnsupported(id: string): AuxCompleteResult {
  return {
    id,
    ok: false,
    code: "unsupported",
    error: "the running pod does not support auxiliary completions — restart Pi in the pod / reattach",
  };
}

type AuxEnvelope =
  | { v: 1; id: string; op: "complete"; ok: boolean; data?: unknown; error?: { code?: unknown; message?: unknown } };

function decodeAuxEnvelope(payload: string): unknown {
  const decoded = decodeWireJson(payload, AUX_MAX_ENCODED_RESPONSE_BYTES);
  if (!decoded.ok) throw new Error("invalid aux response encoding");
  return decoded.value;
}

/**
 * Run one auxiliary completion inside pod-side pi over the prompt tunnel.
 *
 * The gateway generates a unique wire id per operation (see `wireId` option) for the pod
 * tunnel request and remaps the pod reply back to the caller id. Pod replies for unknown
 * or already-completed wire ids are dropped — never fanned out, never delivered to a
 * different caller. On timeout or transport error the pod is told to cancel, best-effort.
 */
export async function invokeAuxComplete(
  rpc: RpcClientBase,
  request: AuxCompleteRequest,
  options?: { signal?: AbortSignal; wireId?: string },
): Promise<AuxCompleteResult> {
  const timeoutMs = Math.min(request.timeoutMs ?? 60000, 120000);
  const wireId = options?.wireId ?? randomUUID();
  const encodedRequest = encodeWireJson({
    v: AUX_BRIDGE_PROTOCOL_VERSION,
    id: wireId,
    op: "complete",
    provider: request.provider,
    model: request.model,
    ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
    messages: request.messages,
    ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
    maxTokens: request.maxTokens ?? 2048,
  });
  if (Buffer.byteLength(encodedRequest, "utf8") > AUX_MAX_ENCODED_REQUEST_BYTES) {
    return {
      id: request.id,
      ok: false,
      code: "invalid_request",
      error: "aux request exceeded the configured limit",
    };
  }

  let cancelSent = false;
  const fireCancel = () => {
    if (cancelSent) return;
    cancelSent = true;
    void fireAuxCancel(rpc, wireId);
  };

  return new Promise<AuxCompleteResult>((resolve, reject) => {
    const abortController = new AbortController();
    let settled = false;
    let promptDone = false;
    let acknowledgement: AuxCompleteResult | undefined;

    const onAbort = () => abortController.abort();
    if (options?.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (outcome: { result: AuxCompleteResult } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offEvent();
      offLifecycle();
      options?.signal?.removeEventListener("abort", onAbort);
      if ("error" in outcome) {
        fireCancel();
        abortController.abort(outcome.error);
        reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)));
      } else {
        resolve(outcome.result);
      }
    };
    const maybeFinish = () => {
      if (promptDone && acknowledgement !== undefined) finish({ result: acknowledgement });
    };
    const accept = (candidate: unknown) => {
      if (!isPlainObject(candidate)) throw new Error("aux response must be an object");
      const envelope = candidate as unknown as AuxEnvelope;
      if (envelope.v !== AUX_BRIDGE_PROTOCOL_VERSION || envelope.id !== wireId || envelope.op !== "complete" || typeof envelope.ok !== "boolean") {
        throw new Error("aux response did not match its request");
      }
      if (envelope.ok) {
        const data = isPlainObject(envelope.data) ? envelope.data : {};
        acknowledgement = {
          id: request.id,
          ok: true,
          ...(typeof data["text"] === "string" ? { text: data["text"] as string } : {}),
          ...(typeof data["stopReason"] === "string" ? { stopReason: data["stopReason"] as string } : {}),
          ...("usage" in data ? { usage: data["usage"] } : {}),
        };
      } else {
        const error = isPlainObject(envelope.error) ? envelope.error : {};
        acknowledgement = {
          id: request.id,
          ok: false,
          ...(typeof error["code"] === "string" ? { code: error["code"] as string } : { code: "completion_failed" }),
          ...(typeof error["message"] === "string" ? { error: error["message"] as string } : { error: "aux completion failed" }),
        };
      }
      maybeFinish();
    };
    const onEvent = (event: AgentSessionEvent) => {
      const candidate = event as { type?: unknown; method?: unknown; message?: unknown };
      if (candidate.type !== "extension_ui_request" || candidate.method !== "notify" || typeof candidate.message !== "string") return;
      if (!candidate.message.startsWith(AUX_NOTIFICATION_PREFIX)) return;
      try {
        const decoded = decodeAuxEnvelope(candidate.message.slice(AUX_NOTIFICATION_PREFIX.length));
        // Correlate by the server-owned wire id; traffic for another op is never ours to consume.
        if (isPlainObject(decoded) && decoded["id"] !== wireId) return;
        accept(decoded);
      } catch (error) {
        finish({ error });
      }
    };
    const offEvent = rpc.onEvent(onEvent);
    const offLifecycle = rpc.onLifecycleInvalidated((error) => finish({ error }));
    const timer = setTimeout(() => {
      finish({ error: new Error("aux completion timed out") });
    }, timeoutMs);
    timer.unref?.();

    rpc.prompt(`/${AUX_COMPLETE_COMMAND} ${encodedRequest}`, undefined, {
      signal: abortController.signal,
      timeoutMs,
    }).then(
      () => {
        promptDone = true;
        maybeFinish();
      },
      (error) => finish({ error }),
    );
  });
}

/** Tell the pod to abort an aux op. Fire-and-forget: unknown ids are a silent pod-side no-op. */
export function fireAuxCancel(rpc: RpcClientBase, id: string): void {
  if (!isBoundedString(id, TREE_BRIDGE_MAX_ID_LENGTH)) return;
  const encoded = encodeWireJson({ v: AUX_BRIDGE_PROTOCOL_VERSION, id, op: "cancel" });
  if (Buffer.byteLength(encoded, "utf8") > AUX_MAX_ENCODED_REQUEST_BYTES) return;
  void rpc.prompt(`/${AUX_CANCEL_COMMAND} ${encoded}`, undefined, { timeoutMs: 15_000 }).catch(() => {});
}
