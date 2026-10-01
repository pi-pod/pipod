import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RpcClientBase } from "../rpc.js";
import {
  SEED_BRIDGE_MAX_ENCODED_RESPONSE_BYTES,
  SEED_BRIDGE_NOTIFICATION_PREFIX,
  SEED_BRIDGE_PROTOCOL_VERSION,
  SEED_CHUNK_CONTEXT_COMMAND,
  SEED_CHUNK_MAX_CHUNKS,
  SEED_CHUNK_MAX_JSON_BYTES,
  SEED_CHUNK_MAX_PART_CHARS,
  SEED_CHUNK_NOTIFICATION_PREFIX,
  SEED_CHUNK_TREE_SUMMARY_COMMAND,
  SEED_CONTEXT_COMMAND,
  SEED_TREE_SUMMARY_COMMAND,
  TREE_BRIDGE_LABEL_COMMAND,
  TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES,
  TREE_BRIDGE_MAX_ENCODED_RESPONSE_BYTES,
  TREE_BRIDGE_MAX_ENTRY_ID_LENGTH,
  TREE_BRIDGE_MAX_ID_LENGTH,
  TREE_BRIDGE_MAX_LABEL_LENGTH,
  TREE_BRIDGE_NAVIGATE_COMMAND,
  TREE_BRIDGE_NAVIGATE_V2_COMMAND,
  TREE_BRIDGE_NOTIFICATION_PREFIX,
  TREE_BRIDGE_PROTOCOL_VERSION,
} from "../../shim/pi-pod-ext.js";
import { decodeWireJson, encodeWireJson, isBoundedString, isPlainObject } from "../../wire-codec.js";

export const TREE_BRIDGE_TIMEOUT_MS = 15_000;
export const SEED_BRIDGE_TIMEOUT_MS = 60_000;

export type TreeBridgeOperation = "navigate" | "label";

export type TreeBridgeRequest =
  | { v: 1; id: string; op: "navigate"; targetId: string }
  | { v: 1; id: string; op: "label"; entryId: string; label: string | null };

export type TreeBridgeSuccess = {
  v: 1;
  id: string;
  op: TreeBridgeOperation;
  ok: true;
  data: { cancelled?: boolean; leafId: string | null; editorText?: string };
};

export type TreeBridgeFailure = {
  v: 1;
  id: string;
  op: TreeBridgeOperation;
  ok: false;
  error: { code: string; message: string };
};

export type TreeBridgeResponse = TreeBridgeSuccess | TreeBridgeFailure;

interface PendingAcknowledgement {
  op: TreeBridgeOperation;
  accept(response: TreeBridgeResponse): void;
  fail(error: Error, ambiguous?: boolean): void;
}

export interface PodExtensionBridgeOptions {
  getCommands: () => unknown[];
  timeoutMs?: number;
  seedTimeoutMs?: number;
  onAmbiguousFailure?: () => void | Promise<void>;
}

export class PodExtensionBridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "PodExtensionBridgeError";
  }
}

function extensionCommandNames(commands: unknown[]): Set<string> {
  return new Set(
    commands.flatMap((command) => {
      const candidate = command as { name?: unknown; source?: unknown };
      return typeof candidate.name === "string" && candidate.source === "extension" ? [candidate.name] : [];
    }),
  );
}

export function supportsNavigateEditorText(commands: unknown[]): boolean {
  return extensionCommandNames(commands).has(TREE_BRIDGE_NAVIGATE_V2_COMMAND);
}

export function supportsTreeBridge(commands: unknown[]): boolean {
  const names = extensionCommandNames(commands);
  return names.has(TREE_BRIDGE_NAVIGATE_COMMAND) && names.has(TREE_BRIDGE_LABEL_COMMAND);
}

export function supportsSeedBridge(commands: unknown[]): boolean {
  const names = extensionCommandNames(commands);
  return names.has(SEED_CONTEXT_COMMAND) && names.has(SEED_TREE_SUMMARY_COMMAND);
}

export function supportsSeedBridgeChunks(commands: unknown[]): boolean {
  const names = extensionCommandNames(commands);
  return names.has(SEED_CHUNK_CONTEXT_COMMAND) && names.has(SEED_CHUNK_TREE_SUMMARY_COMMAND);
}

export type SeedBridgeOperation = "get-context" | "get-tree-summary";

export type SeedContextData = {
  entries: SessionEntry[];
  leafId: string | null;
  compactionCount: number;
};

export type SeedTreeSummaryNode = {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  preview: string;
  role?: string | null;
  label?: string;
  labelTimestamp?: string;
  customType?: string;
  tokensBefore?: number;
  modelId?: string;
  thinkingLevel?: string;
  name?: string;
  toolName?: string;
};

export type SeedTreeSummaryData = {
  leafId: string | null;
  nodes: SeedTreeSummaryNode[];
};

export interface SessionSeedBridge {
  supportsSeedBridge(commands?: unknown[]): boolean;
  getContext(): Promise<SeedContextData>;
  getTreeSummary(): Promise<SeedTreeSummaryData>;
}

type SeedBridgeSuccess<T> = { v: 1; id: string; op: SeedBridgeOperation; ok: true; data: T };
type SeedBridgeFailure = { v: 1; id: string; op: SeedBridgeOperation; ok: false; error: { code: string; message: string } };
type SeedBridgeResponse<T> = SeedBridgeSuccess<T> | SeedBridgeFailure;

interface PendingSeedAcknowledgement {
  op: SeedBridgeOperation;
  chunked: boolean;
  previousSeq: number;
  total: number | null;
  encoding: "gz" | "raw" | null;
  parts: string[];
  encodedLength: number;
  resetTimeout(): void;
  accept(response: SeedBridgeResponse<unknown>): void;
  fail(error: Error, ambiguous?: boolean): void;
}

export class PodExtensionBridge implements SessionSeedBridge {
  private readonly pending = new Map<string, PendingAcknowledgement>();
  private readonly pendingSeed = new Map<string, PendingSeedAcknowledgement>();
  private readonly timeoutMs: number;
  private readonly seedTimeoutMs: number;
  private mutationTail: Promise<void> = Promise.resolve();
  private disposedError: Error | null = null;
  private readonly unwireLifecycle: () => void;

  constructor(
    private readonly rpc: RpcClientBase,
    private readonly options: PodExtensionBridgeOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? TREE_BRIDGE_TIMEOUT_MS;
    this.seedTimeoutMs = options.seedTimeoutMs ?? SEED_BRIDGE_TIMEOUT_MS;
    this.unwireLifecycle = rpc.onLifecycleInvalidated((error) => {
      for (const waiter of [...this.pending.values()]) waiter.fail(error, true);
      for (const waiter of [...this.pendingSeed.values()]) waiter.fail(error, true);
    });
  }

  supportsTreeBridge(commands: unknown[] = this.options.getCommands()): boolean {
    return supportsTreeBridge(commands);
  }

  supportsSeedBridge(commands: unknown[] = this.options.getCommands()): boolean {
    return supportsSeedBridge(commands);
  }

  supportsSeedBridgeChunks(commands: unknown[] = this.options.getCommands()): boolean {
    return supportsSeedBridgeChunks(commands);
  }

  supportsNavigateEditorText(commands: unknown[] = this.options.getCommands()): boolean {
    return supportsNavigateEditorText(commands);
  }

  consumeExtensionNotification(request: unknown): boolean {
    const event = request as { type?: unknown; method?: unknown; message?: unknown };
    if (event.type !== "extension_ui_request" || typeof event.message !== "string") return false;
    if (event.message.startsWith(SEED_CHUNK_NOTIFICATION_PREFIX)) {
      this.consumeSeedChunkNotification(event.method, event.message.slice(SEED_CHUNK_NOTIFICATION_PREFIX.length));
      return true;
    }
    if (event.message.startsWith(SEED_BRIDGE_NOTIFICATION_PREFIX)) {
      this.consumeSeedNotification(event.method, event.message.slice(SEED_BRIDGE_NOTIFICATION_PREFIX.length));
      return true;
    }
    if (!event.message.startsWith(TREE_BRIDGE_NOTIFICATION_PREFIX)) return false;

    const encoded = event.message.slice(TREE_BRIDGE_NOTIFICATION_PREFIX.length);
    let candidate: unknown;
    try {
      candidate = decodeResponse(encoded);
      if (event.method !== "notify") {
        throw new PodExtensionBridgeError("reserved tree bridge traffic used an invalid UI method", "invalid_response");
      }
      const response = validateResponse(candidate);
      const waiter = this.pending.get(response.id);
      if (!waiter) return true;
      if (response.op !== waiter.op) {
        waiter.fail(new PodExtensionBridgeError("tree bridge response operation did not match its request", "invalid_response"));
      } else {
        waiter.accept(response);
      }
    } catch (error) {
      const id = extractCandidateId(candidate);
      if (id) {
        this.pending.get(id)?.fail(
          error instanceof Error ? error : new PodExtensionBridgeError(String(error), "invalid_response"),
        );
      }
    }
    return true;
  }

  navigate(targetId: string): Promise<{ cancelled: boolean; leafId: string | null; editorText?: string }> {
    if (!isBoundedString(targetId, TREE_BRIDGE_MAX_ENTRY_ID_LENGTH)) {
      return Promise.reject(new PodExtensionBridgeError("invalid tree navigation target", "invalid_target"));
    }
    return this.serialize(async () => {
      const result = await this.invoke({ op: "navigate", targetId });
      return {
        cancelled: result.cancelled === true,
        leafId: result.leafId,
        ...(typeof result.editorText === "string" ? { editorText: result.editorText } : {}),
      };
    });
  }

  setLabel(entryId: string, label: string | null): Promise<{ leafId: string | null }> {
    if (!isBoundedString(entryId, TREE_BRIDGE_MAX_ENTRY_ID_LENGTH)) {
      return Promise.reject(new PodExtensionBridgeError("invalid tree label entry", "invalid_entry"));
    }
    if (label !== null && (typeof label !== "string" || label.length > TREE_BRIDGE_MAX_LABEL_LENGTH)) {
      return Promise.reject(new PodExtensionBridgeError("tree label exceeds the configured limit", "invalid_label"));
    }
    return this.serialize(async () => {
      const result = await this.invoke({ op: "label", entryId, label });
      return { leafId: result.leafId };
    });
  }

  getContext(): Promise<SeedContextData> {
    return this.invokeSeed("get-context");
  }

  getTreeSummary(): Promise<SeedTreeSummaryData> {
    return this.invokeSeed("get-tree-summary");
  }

  dispose(error = new Error("tree bridge was disposed")): void {
    if (this.disposedError) return;
    this.disposedError = error;
    this.unwireLifecycle();
    for (const waiter of [...this.pending.values()]) waiter.fail(error);
    for (const waiter of [...this.pendingSeed.values()]) waiter.fail(error);
    this.pending.clear();
    this.pendingSeed.clear();
  }

  private consumeSeedNotification(method: unknown, encoded: string): void {
    let candidate: unknown;
    try {
      candidate = decodeSeedResponse(encoded);
      if (method !== "notify") {
        throw new PodExtensionBridgeError("reserved seed bridge traffic used an invalid UI method", "invalid_response");
      }
      const response = validateSeedResponse(candidate);
      const waiter = this.pendingSeed.get(response.id);
      if (!waiter) return;
      if (waiter.chunked) {
        waiter.fail(new PodExtensionBridgeError("seed bridge returned a single-shot response for a chunked request", "invalid_response"));
      } else if (response.op !== waiter.op) {
        waiter.fail(new PodExtensionBridgeError("seed bridge response operation did not match its request", "invalid_response"));
      } else {
        waiter.accept(response);
      }
    } catch (error) {
      const id = extractCandidateId(candidate);
      if (id) {
        this.pendingSeed.get(id)?.fail(
          error instanceof Error ? error : new PodExtensionBridgeError(String(error), "invalid_response"),
        );
      }
    }
  }

  private consumeSeedChunkNotification(method: unknown, payload: string): void {
    const fields = payload.split(" ");
    const id = fields[0];
    if (!isBoundedString(id, TREE_BRIDGE_MAX_ID_LENGTH)) return;
    const waiter = this.pendingSeed.get(id);
    if (!waiter) return;

    try {
      if (fields.length !== 5) {
        throw new PodExtensionBridgeError("invalid seed chunk header", "invalid_response");
      }
      if (method !== "notify") {
        throw new PodExtensionBridgeError("reserved seed chunk traffic used an invalid UI method", "invalid_response");
      }
      if (!waiter.chunked) {
        throw new PodExtensionBridgeError("seed bridge returned chunks for a single-shot request", "invalid_response");
      }

      const [, seqText, totalText, encoding, part] = fields;
      if (!/^[0-9]{1,7}$/.test(seqText!) || !/^[0-9]{1,7}$/.test(totalText!)) {
        throw new PodExtensionBridgeError("invalid seed chunk sequence", "invalid_response");
      }
      const seq = Number(seqText);
      const total = Number(totalText);
      if (seq < 1 || seq > total || total > SEED_CHUNK_MAX_CHUNKS || seq !== waiter.previousSeq + 1) {
        throw new PodExtensionBridgeError("invalid seed chunk sequence", "invalid_response");
      }
      if (encoding !== "gz" && encoding !== "raw") {
        throw new PodExtensionBridgeError("invalid seed chunk encoding", "invalid_response");
      }
      if (waiter.total !== null && waiter.total !== total) {
        throw new PodExtensionBridgeError("seed chunk total changed during response", "invalid_response");
      }
      if (waiter.encoding !== null && waiter.encoding !== encoding) {
        throw new PodExtensionBridgeError("seed chunk encoding changed during response", "invalid_response");
      }
      if (!part || part.length > SEED_CHUNK_MAX_PART_CHARS || !/^[A-Za-z0-9_-]+$/.test(part)) {
        throw new PodExtensionBridgeError("invalid seed chunk payload", "invalid_response");
      }
      const encodedLength = waiter.encodedLength + part.length;
      if (encodedLength > SEED_BRIDGE_MAX_ENCODED_RESPONSE_BYTES) {
        throw new PodExtensionBridgeError("seed chunk response exceeded the configured limit", "invalid_response");
      }

      waiter.previousSeq = seq;
      waiter.total = total;
      waiter.encoding = encoding;
      waiter.parts.push(part);
      waiter.encodedLength = encodedLength;
      waiter.resetTimeout();

      if (seq !== total) return;
      const candidate = decodeSeedChunkResponse(waiter.parts.join(""), encoding);
      const response = validateSeedResponse(candidate);
      if (response.id !== id) {
        throw new PodExtensionBridgeError("seed chunk response id did not match its request", "invalid_response");
      }
      if (response.op !== waiter.op) {
        throw new PodExtensionBridgeError("seed bridge response operation did not match its request", "invalid_response");
      }
      waiter.accept(response);
    } catch (error) {
      waiter.fail(error instanceof Error ? error : new PodExtensionBridgeError(String(error), "invalid_response"));
    }
  }

  private invokeSeed<T>(op: SeedBridgeOperation): Promise<T> {
    if (this.disposedError) return Promise.reject(this.disposedError);
    const commands = this.options.getCommands();
    const chunked = this.supportsSeedBridgeChunks(commands);
    if (!chunked && !this.supportsSeedBridge(commands)) {
      return Promise.reject(
        new PodExtensionBridgeError(
          "This running pod uses an older pi pod extension. Exit Pi, then attach again so pi pod can load the updated extension.",
          "seed_bridge_unavailable",
        ),
      );
    }
    const id = randomUUID();
    if (!isBoundedString(id, TREE_BRIDGE_MAX_ID_LENGTH)) {
      return Promise.reject(new PodExtensionBridgeError("failed to generate a valid seed bridge request id", "invalid_id"));
    }
    const encoded = encodeWireJson({ v: SEED_BRIDGE_PROTOCOL_VERSION, id, op });
    if (Buffer.byteLength(encoded, "utf8") > TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES) {
      return Promise.reject(new PodExtensionBridgeError("seed bridge request exceeded the configured limit", "payload_too_large"));
    }
    const command = chunked
      ? op === "get-context"
        ? SEED_CHUNK_CONTEXT_COMMAND
        : SEED_CHUNK_TREE_SUMMARY_COMMAND
      : op === "get-context"
        ? SEED_CONTEXT_COMMAND
        : SEED_TREE_SUMMARY_COMMAND;
    return new Promise<T>((resolve, reject) => {
      const abortController = new AbortController();
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      let promptDone = false;
      let acknowledgement: T | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        this.pendingSeed.delete(id);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        abortController.abort(error);
        reject(error);
      };
      const timeoutMessage = chunked
        ? `seed bridge ${op} acknowledgement timed out after ${this.seedTimeoutMs}ms`
        : `seed bridge ${op} acknowledgement timed out after ${this.seedTimeoutMs}ms; the pod is running an older pi pod extension that cannot deliver large sessions — exit Pi in the pod (or run pipod stop <id>) and attach again to load the updated extension`;
      const resetTimeout = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          fail(new PodExtensionBridgeError(timeoutMessage, "timeout"));
        }, this.seedTimeoutMs);
      };
      const maybeResolve = () => {
        if (settled || !promptDone || acknowledgement === null) return;
        settled = true;
        cleanup();
        resolve(acknowledgement);
      };
      this.pendingSeed.set(id, {
        op,
        chunked,
        previousSeq: 0,
        total: null,
        encoding: null,
        parts: [],
        encodedLength: 0,
        resetTimeout,
        accept: (response) => {
          if (response.ok === false) {
            fail(new PodExtensionBridgeError(response.error.message, response.error.code));
            return;
          }
          acknowledgement = response.data as T;
          maybeResolve();
        },
        fail: (error) => fail(error),
      });
      resetTimeout();
      this.rpc
        .prompt(`/${command} ${encoded}`, undefined, { signal: abortController.signal })
        .then(() => {
          promptDone = true;
          maybeResolve();
        })
        .catch((error) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(run, run);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private invoke(request: Omit<Extract<TreeBridgeRequest, { op: "navigate" }>, "v" | "id"> | Omit<Extract<TreeBridgeRequest, { op: "label" }>, "v" | "id">): Promise<TreeBridgeSuccess["data"]> {
    if (this.disposedError) return Promise.reject(this.disposedError);
    if (!this.supportsTreeBridge()) {
      return Promise.reject(
        new PodExtensionBridgeError(
          "This running pod uses an older pi pod extension. Exit Pi, then attach again so pi pod can load the updated extension.",
          "tree_bridge_unavailable",
        ),
      );
    }

    const id = randomUUID();
    if (!isBoundedString(id, TREE_BRIDGE_MAX_ID_LENGTH)) {
      return Promise.reject(new PodExtensionBridgeError("failed to generate a valid tree bridge request id", "invalid_id"));
    }
    const envelope = { v: TREE_BRIDGE_PROTOCOL_VERSION, id, ...request } as TreeBridgeRequest;
    const encoded = encodeWireJson(envelope);
    if (Buffer.byteLength(encoded, "utf8") > TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES) {
      return Promise.reject(new PodExtensionBridgeError("tree bridge request exceeded the configured limit", "payload_too_large"));
    }
    const command =
      request.op === "navigate"
        ? this.supportsNavigateEditorText()
          ? TREE_BRIDGE_NAVIGATE_V2_COMMAND
          : TREE_BRIDGE_NAVIGATE_COMMAND
        : TREE_BRIDGE_LABEL_COMMAND;

    return new Promise<TreeBridgeSuccess["data"]>((resolve, reject) => {
      const abortController = new AbortController();
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      let promptDone = false;
      let acknowledgement: TreeBridgeSuccess["data"] | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        this.pending.delete(id);
      };
      const recover = () => {
        try {
          void Promise.resolve(this.options.onAmbiguousFailure?.()).catch(() => {});
        } catch {
          // Recovery is deliberately best effort; preserve the original failure.
        }
      };
      const fail = (error: Error, ambiguous: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        abortController.abort(error);
        if (ambiguous) recover();
        reject(error);
      };
      const maybeResolve = () => {
        if (settled || !promptDone || !acknowledgement) return;
        settled = true;
        cleanup();
        resolve(acknowledgement);
      };

      this.pending.set(id, {
        op: request.op,
        accept: (response) => {
          if (response.ok === false) {
            fail(new PodExtensionBridgeError(response.error.message, response.error.code), false);
            return;
          }
          acknowledgement = response.data;
          maybeResolve();
        },
        fail: (error, ambiguous = false) => fail(error, ambiguous),
      });

      timer = setTimeout(() => {
        fail(
          new PodExtensionBridgeError(
            `tree bridge ${request.op} acknowledgement timed out after ${this.timeoutMs}ms; the final pod state is uncertain`,
            "timeout",
          ),
          true,
        );
      }, this.timeoutMs);

      this.rpc
        .prompt(`/${command} ${encoded}`, undefined, { signal: abortController.signal })
        .then(() => {
          promptDone = true;
          maybeResolve();
        })
        .catch((error) => {
          fail(error instanceof Error ? error : new Error(String(error)), true);
        });
    });
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function decodeResponse(encoded: string): unknown {
  const decoded = decodeWireJson(encoded, TREE_BRIDGE_MAX_ENCODED_RESPONSE_BYTES);
  if (!decoded.ok) {
    if (decoded.reason === "non_canonical") {
      throw new PodExtensionBridgeError("tree bridge response is not canonical base64url", "invalid_response");
    }
    if (decoded.reason === "invalid_utf8_json") {
      throw new PodExtensionBridgeError("tree bridge response is not valid UTF-8 JSON", "invalid_response");
    }
    throw new PodExtensionBridgeError("invalid or oversized tree bridge response", "invalid_response");
  }
  return decoded.value;
}

function validateResponse(value: unknown): TreeBridgeResponse {
  if (!isPlainObject(value)) throw new PodExtensionBridgeError("tree bridge response must be an object", "invalid_response");
  if (value.v !== TREE_BRIDGE_PROTOCOL_VERSION) {
    throw new PodExtensionBridgeError("unsupported tree bridge response version", "invalid_response");
  }
  if (!isBoundedString(value.id, TREE_BRIDGE_MAX_ID_LENGTH)) {
    throw new PodExtensionBridgeError("invalid tree bridge response id", "invalid_response");
  }
  if (value.op !== "navigate" && value.op !== "label") {
    throw new PodExtensionBridgeError("invalid tree bridge response operation", "invalid_response");
  }

  if (value.ok === true) {
    if (!hasExactKeys(value, ["v", "id", "op", "ok", "data"]) || !isPlainObject(value.data)) {
      throw new PodExtensionBridgeError("invalid tree bridge success response", "invalid_response");
    }
    const data = value.data;
    const validKeys =
      hasExactKeys(data, ["leafId"]) ||
      (value.op === "navigate" &&
        (hasExactKeys(data, ["cancelled", "leafId"]) || hasExactKeys(data, ["cancelled", "leafId", "editorText"])));
    if (!validKeys) {
      throw new PodExtensionBridgeError("invalid tree bridge success data", "invalid_response");
    }
    if (data.editorText !== undefined && typeof data.editorText !== "string") {
      throw new PodExtensionBridgeError("invalid tree bridge editor text", "invalid_response");
    }
    if (data.leafId !== null && !isBoundedString(data.leafId, TREE_BRIDGE_MAX_ENTRY_ID_LENGTH)) {
      throw new PodExtensionBridgeError("invalid tree bridge response leaf", "invalid_response");
    }
    if (value.op === "navigate" && data.cancelled !== undefined && typeof data.cancelled !== "boolean") {
      throw new PodExtensionBridgeError("invalid tree bridge cancellation result", "invalid_response");
    }
    return value as unknown as TreeBridgeSuccess;
  }

  if (value.ok === false) {
    if (!hasExactKeys(value, ["v", "id", "op", "ok", "error"]) || !isPlainObject(value.error)) {
      throw new PodExtensionBridgeError("invalid tree bridge failure response", "invalid_response");
    }
    if (
      !hasExactKeys(value.error, ["code", "message"]) ||
      !isBoundedString(value.error.code, 128) ||
      !isBoundedString(value.error.message, 1024)
    ) {
      throw new PodExtensionBridgeError("invalid tree bridge remote error", "invalid_response");
    }
    return value as unknown as TreeBridgeFailure;
  }

  throw new PodExtensionBridgeError("tree bridge response lacks a boolean result", "invalid_response");
}

function extractCandidateId(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  return isBoundedString(value.id, TREE_BRIDGE_MAX_ID_LENGTH) ? value.id : null;
}


function decodeSeedResponse(encoded: string): unknown {
  const decoded = decodeWireJson(encoded, SEED_BRIDGE_MAX_ENCODED_RESPONSE_BYTES);
  if (!decoded.ok) {
    if (decoded.reason === "non_canonical") {
      throw new PodExtensionBridgeError("seed bridge response is not canonical base64url", "invalid_response");
    }
    if (decoded.reason === "invalid_utf8_json") {
      throw new PodExtensionBridgeError("seed bridge response is not valid UTF-8 JSON", "invalid_response");
    }
    throw new PodExtensionBridgeError("invalid or oversized seed bridge response", "invalid_response");
  }
  return decoded.value;
}

function decodeSeedChunkResponse(encoded: string, encoding: "gz" | "raw"): unknown {
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) {
    throw new PodExtensionBridgeError("seed chunk response is not canonical base64url", "invalid_response");
  }
  try {
    const jsonBytes =
      encoding === "gz" ? gunzipSync(bytes, { maxOutputLength: SEED_CHUNK_MAX_JSON_BYTES }) : bytes;
    const json = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
    return JSON.parse(json) as unknown;
  } catch {
    throw new PodExtensionBridgeError("seed chunk response is not valid compressed UTF-8 JSON", "invalid_response");
  }
}

function validateSeedResponse(value: unknown): SeedBridgeResponse<unknown> {
  if (!isPlainObject(value)) throw new PodExtensionBridgeError("seed bridge response must be an object", "invalid_response");
  if (value.v !== SEED_BRIDGE_PROTOCOL_VERSION) {
    throw new PodExtensionBridgeError("unsupported seed bridge response version", "invalid_response");
  }
  if (!isBoundedString(value.id, TREE_BRIDGE_MAX_ID_LENGTH)) {
    throw new PodExtensionBridgeError("invalid seed bridge response id", "invalid_response");
  }
  if (value.op !== "get-context" && value.op !== "get-tree-summary") {
    throw new PodExtensionBridgeError("invalid seed bridge response operation", "invalid_response");
  }
  if (value.ok === true) {
    if (!hasExactKeys(value, ["v", "id", "op", "ok", "data"]) || !isPlainObject(value.data)) {
      throw new PodExtensionBridgeError("invalid seed bridge success response", "invalid_response");
    }
    if (value.op === "get-context") validateSeedContextData(value.data);
    else validateSeedTreeSummaryData(value.data);
    return value as unknown as SeedBridgeSuccess<unknown>;
  }
  if (value.ok === false) {
    if (!hasExactKeys(value, ["v", "id", "op", "ok", "error"]) || !isPlainObject(value.error)) {
      throw new PodExtensionBridgeError("invalid seed bridge failure response", "invalid_response");
    }
    if (
      !hasExactKeys(value.error, ["code", "message"]) ||
      !isBoundedString(value.error.code, 128) ||
      !isBoundedString(value.error.message, 1024)
    ) {
      throw new PodExtensionBridgeError("invalid seed bridge remote error", "invalid_response");
    }
    return value as unknown as SeedBridgeFailure;
  }
  throw new PodExtensionBridgeError("seed bridge response lacks a boolean result", "invalid_response");
}

function validateSeedContextData(data: Record<string, unknown>): void {
  if (!Array.isArray(data.entries) || typeof data.compactionCount !== "number" || !Number.isFinite(data.compactionCount)) {
    throw new PodExtensionBridgeError("invalid seed context data", "invalid_response");
  }
  if (data.leafId !== null && !isBoundedString(data.leafId, TREE_BRIDGE_MAX_ENTRY_ID_LENGTH)) {
    throw new PodExtensionBridgeError("invalid seed context leaf", "invalid_response");
  }
}

function validateSeedTreeSummaryData(data: Record<string, unknown>): void {
  if (!Array.isArray(data.nodes)) {
    throw new PodExtensionBridgeError("invalid seed tree summary data", "invalid_response");
  }
  if (data.leafId !== null && !isBoundedString(data.leafId, TREE_BRIDGE_MAX_ENTRY_ID_LENGTH)) {
    throw new PodExtensionBridgeError("invalid seed tree summary leaf", "invalid_response");
  }
  for (const node of data.nodes) {
    if (!isPlainObject(node) || !isBoundedString(node.id, TREE_BRIDGE_MAX_ENTRY_ID_LENGTH) || typeof node.type !== "string" || typeof node.preview !== "string") {
      throw new PodExtensionBridgeError("invalid seed tree summary node", "invalid_response");
    }
    if (node.parentId !== null && node.parentId !== undefined && !isBoundedString(node.parentId, TREE_BRIDGE_MAX_ENTRY_ID_LENGTH)) {
      throw new PodExtensionBridgeError("invalid seed tree summary parent", "invalid_response");
    }
  }
}
