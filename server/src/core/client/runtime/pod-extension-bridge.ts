import { randomUUID } from "node:crypto";
import type { RpcClientBase } from "../rpc.js";
import {
  TREE_BRIDGE_LABEL_COMMAND,
  TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES,
  TREE_BRIDGE_MAX_ENCODED_RESPONSE_BYTES,
  TREE_BRIDGE_MAX_ENTRY_ID_LENGTH,
  TREE_BRIDGE_MAX_ID_LENGTH,
  TREE_BRIDGE_MAX_LABEL_LENGTH,
  TREE_BRIDGE_NAVIGATE_COMMAND,
  TREE_BRIDGE_NOTIFICATION_PREFIX,
  TREE_BRIDGE_PROTOCOL_VERSION,
} from "../../shim/pi-pod-ext.js";
import { decodeWireJson, encodeWireJson, isBoundedString, isPlainObject } from "../../wire-codec.js";

export const TREE_BRIDGE_TIMEOUT_MS = 15_000;

export type TreeBridgeOperation = "navigate" | "label";

export type TreeBridgeRequest =
  | { v: 1; id: string; op: "navigate"; targetId: string }
  | { v: 1; id: string; op: "label"; entryId: string; label: string | null };

export type TreeBridgeSuccess = {
  v: 1;
  id: string;
  op: TreeBridgeOperation;
  ok: true;
  data: { cancelled?: boolean; leafId: string | null };
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

export function supportsTreeBridge(commands: unknown[]): boolean {
  const names = new Set(
    commands.flatMap((command) => {
      const candidate = command as { name?: unknown; source?: unknown };
      return typeof candidate.name === "string" && candidate.source === "extension" ? [candidate.name] : [];
    }),
  );
  return names.has(TREE_BRIDGE_NAVIGATE_COMMAND) && names.has(TREE_BRIDGE_LABEL_COMMAND);
}

export class PodExtensionBridge {
  private readonly pending = new Map<string, PendingAcknowledgement>();
  private readonly timeoutMs: number;
  private mutationTail: Promise<void> = Promise.resolve();
  private disposedError: Error | null = null;
  private readonly unwireLifecycle: () => void;

  constructor(
    private readonly rpc: RpcClientBase,
    private readonly options: PodExtensionBridgeOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? TREE_BRIDGE_TIMEOUT_MS;
    this.unwireLifecycle = rpc.onLifecycleInvalidated((error) => {
      for (const waiter of [...this.pending.values()]) waiter.fail(error, true);
    });
  }

  supportsTreeBridge(commands: unknown[] = this.options.getCommands()): boolean {
    return supportsTreeBridge(commands);
  }

  consumeExtensionNotification(request: unknown): boolean {
    const event = request as { type?: unknown; method?: unknown; message?: unknown };
    if (
      event.type !== "extension_ui_request" ||
      typeof event.message !== "string" ||
      !event.message.startsWith(TREE_BRIDGE_NOTIFICATION_PREFIX)
    ) {
      return false;
    }

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

  navigate(targetId: string): Promise<{ cancelled: boolean; leafId: string | null }> {
    if (!isBoundedString(targetId, TREE_BRIDGE_MAX_ENTRY_ID_LENGTH)) {
      return Promise.reject(new PodExtensionBridgeError("invalid tree navigation target", "invalid_target"));
    }
    return this.serialize(async () => {
      const result = await this.invoke({ op: "navigate", targetId });
      return { cancelled: result.cancelled === true, leafId: result.leafId };
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

  dispose(error = new Error("tree bridge was disposed")): void {
    if (this.disposedError) return;
    this.disposedError = error;
    this.unwireLifecycle();
    for (const waiter of [...this.pending.values()]) waiter.fail(error);
    this.pending.clear();
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
          "This running pod uses an older pi-pod extension. Exit Pi, then attach again so pi-pod can load the updated extension.",
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
    const command = request.op === "navigate" ? TREE_BRIDGE_NAVIGATE_COMMAND : TREE_BRIDGE_LABEL_COMMAND;

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
      (value.op === "navigate" && hasExactKeys(data, ["cancelled", "leafId"]));
    if (!validKeys) {
      throw new PodExtensionBridgeError("invalid tree bridge success data", "invalid_response");
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
