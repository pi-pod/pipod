import type { ShimHello } from "../../core/client/frames.js";
import type { ThinkingLevel, ImageContent } from "../../core/client/rpc.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionEndKind } from "./session-state.js";

export function createProvisionalAttachSink(target: WsSink): {
  sink: WsSink;
  commit(): void;
  finishReplay(): void;
  wasClosedBeforeCommit(): boolean;
} {
  const buffered: ServerMessage[] = [];
  let committed = false;
  let replaying = true;
  let closedBeforeCommit = false;
  const sink: WsSink = {
    send: (message) => {
      if (replaying) buffered.push(message);
      else target.send(message);
    },
    close: (code, reason) => {
      if (!committed) {
        closedBeforeCommit = true;
        return;
      }
      target.close(code, reason);
    },
  };
  return {
    sink,
    commit: () => { committed = true; },
    finishReplay: () => {
      replaying = false;
      for (const message of buffered) target.send(message);
      buffered.length = 0;
    },
    wasClosedBeforeCommit: () => closedBeforeCommit,
  };
}

export function replayFromForSession(args: {
  fromSeq: number;
  fromSessionId: string | null;
  currentSessionId: string;
  latestSeq: number;
}): number {
  if (args.fromSessionId === args.currentSessionId) return args.fromSeq;
  if (args.fromSessionId !== null || args.fromSeq > args.latestSeq) return 0;
  // Backward compatibility for clients predating from_session.
  return args.fromSeq;
}

/** The seq range the bounded socket replay skipped, or null when nothing was dropped. */
export function replayGapFor(args: {
  replayFrom: number;
  firstReplayedSeq: number | null;
}): { fromSeq: number; toSeq: number } | null {
  if (args.firstReplayedSeq === null) return null;
  if (args.firstReplayedSeq <= args.replayFrom + 1) return null;
  return { fromSeq: args.replayFrom + 1, toSeq: args.firstReplayedSeq - 1 };
}

/** The tool call a streaming execution event belongs to — the key clients render bubbles on.
 * Events without one cannot be snapshot-cached (they would collide), so they only fan out. */
export function toolCallIdFor(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const raw = (event as { toolCallId?: unknown }).toolCallId;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** Bulk-carrying events that must not be stored verbatim. Live fan-out keeps the original. */
export function persistablePayload(kind: string, event: unknown): unknown {
  if (kind === "agent_end") {
    if (typeof event !== "object" || event === null) return {};
    const willRetry = (event as { willRetry?: unknown }).willRetry;
    return willRetry === undefined ? {} : { willRetry };
  }
  if (kind === "turn_end" || kind === "entry_appended") return {};
  return event;
}

/** Persist at most this many decoded bytes of each pi_stderr frame (keep the crash tail). */
export const PI_STDERR_PERSIST_MAX_BYTES = 8 * 1024;
/** After this many persisted pi_stderr rows, count further frames but do not store them. */
export const PI_STDERR_PERSIST_MAX_ROWS = 500;

/** Redact a control frame for durable storage. Returns null when the row should be skipped. */
export function persistableControlPayload(
  control: unknown,
  state: { stderrPersisted: number; stderrDropped: number },
): unknown | null {
  if (typeof control !== "object" || control === null) return control;
  const event = (control as { event?: unknown }).event;
  if (event === "background_work") return null;
  if (event !== "pi_stderr") return control;
  if (state.stderrPersisted >= PI_STDERR_PERSIST_MAX_ROWS) {
    state.stderrDropped += 1;
    return null;
  }
  state.stderrPersisted += 1;
  return truncatePiStderrData(control);
}

/** Mid-stream journal hole from shim v10+. Null when the control is not a usable gap. */
export function eventReplayGapFromControl(control: unknown): { fromSeq: number; toSeq: number } | null {
  if (typeof control !== "object" || control === null) return null;
  const event = (control as { event?: unknown }).event;
  if (event !== "event_replay_gap") return null;
  const fromSeq = (control as { fromSeq?: unknown }).fromSeq;
  const toSeq = (control as { toSeq?: unknown }).toSeq;
  if (typeof fromSeq !== "number" || typeof toSeq !== "number") return null;
  if (!Number.isFinite(fromSeq) || !Number.isFinite(toSeq) || toSeq < fromSeq) return null;
  return { fromSeq, toSeq };

}

/** Log a mid-stream gap, advance the decoded cursor, and refresh the streaming bubble. */
export function applyEventReplayGap(
  control: unknown,
  session: { lastDecodedShimSeq: number; pod: { id: string } },
  deps: {
    log: { warn: (m: string) => void };
    refreshStreamingSnapshot: () => Promise<unknown> | unknown;
  },
): { fromSeq: number; toSeq: number } | null {
  const gap = eventReplayGapFromControl(control);
  if (!gap) return null;
  deps.log.warn(`pod ${session.pod.id} event replay gap ${gap.fromSeq}..${gap.toSeq}`);
  session.lastDecodedShimSeq = Math.max(session.lastDecodedShimSeq, gap.toSeq);
  void Promise.resolve(deps.refreshStreamingSnapshot()).catch((e) =>
    deps.log.warn(
      `stream snapshot refresh after event replay gap failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`,
    ),
  );
  return gap;

}

/** Snap the decoded cursor to the shim's journal watermark at the end of a handshake replay. */
export function applyEventReplayEnd(
  control: unknown,
  session: { lastDecodedShimSeq: number },
): number | null {
  if (typeof control !== "object" || control === null) return null;
  if ((control as { event?: unknown }).event !== "event_replay_end") return null;
  const lastSeq = (control as { lastSeq?: unknown }).lastSeq;
  if (typeof lastSeq !== "number" || !Number.isFinite(lastSeq) || lastSeq < 0) return null;
  session.lastDecodedShimSeq = Math.max(session.lastDecodedShimSeq, lastSeq);
  return lastSeq;
}

/**
 * How far the shim's journal is ahead of events this gateway has decoded.
 * `null` on v9 (and older) hellos that carry no checkpoint.
 */
export function shimEventCheckpointBacklog(args: {
  shimVersion: string | undefined;
  eventSeq: number | undefined;
  decodedSeq: number;
}): number | null {
  if (Number(args.shimVersion) < 10) return null;
  if (typeof args.eventSeq !== "number" || !Number.isFinite(args.eventSeq)) return null;
  const backlog = args.eventSeq - args.decodedSeq;
  return backlog > 0 ? backlog : 0;

}

export function truncatePiStderrData(control: unknown): unknown {
  if (typeof control !== "object" || control === null) return control;
  const data = (control as { data?: unknown }).data;
  if (typeof data !== "string") return control;
  const raw = Buffer.from(data, "base64");
  if (raw.length <= PI_STDERR_PERSIST_MAX_BYTES) return control;
  return {
    ...(control as object),
    data: raw.subarray(raw.length - PI_STDERR_PERSIST_MAX_BYTES).toString("base64"),
  };
}

/** Hello field so a reconnecting client can tell its from_seq predates available history. */
export function helloFirstAvailableSeq(args: {
  replayFrom: number;
  truncatedBelowSeq: number | null;
}): number | undefined {
  if (args.truncatedBelowSeq == null) return undefined;
  if (args.replayFrom < args.truncatedBelowSeq) return args.truncatedBelowSeq;
  return undefined;
}

const MAX_POD_NAME_LENGTH = 200;
const POD_NAME_UPDATE_ATTEMPTS = 3;

/** A usable server pod name carried by pi's authoritative session rename event. */
export function podNameFromSessionEvent(kind: string, event: unknown): string | null {
  if (kind !== "session_info_changed" || typeof event !== "object" || event === null) return null;
  const raw = (event as { name?: unknown }).name;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name === "") return null;
  if (name.length <= MAX_POD_NAME_LENGTH) return name;
  const last = name.charCodeAt(MAX_POD_NAME_LENGTH - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_POD_NAME_LENGTH - 1 : MAX_POD_NAME_LENGTH;
  return name.slice(0, end);
}

/** Retry transient writes; false means this gateway no longer owns the pod lease. */
export async function retryPodNameUpdate(args: {
  update: () => Promise<boolean>;
  attempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<boolean> {
  const attempts = Math.max(1, args.attempts ?? POD_NAME_UPDATE_ATTEMPTS);
  const sleep = args.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await args.update();
    } catch (e) {
      if (attempt === attempts) throw e;
      await sleep(attempt * 100);
    }
  }
  return false;
}

/** Write the durable name first; announce only when that write landed. */
export async function persistThenAnnouncePodName(args: {
  persist: () => Promise<boolean>;
  announce: () => void;
  attempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<boolean> {
  const updated = await retryPodNameUpdate({
    update: args.persist,
    attempts: args.attempts,
    sleep: args.sleep,
  });
  if (updated) args.announce();
  return updated;
}

export interface PersistedEvent {
  seq: number;
  /** ISO timestamp of the durable row, so clients can render transcript times. */
  ts: string;
}

/** Bounded image validation for WS prompt attachments.
 * Bounds are set by the transport below them, not by taste: the client→pod C frame
 * base64-expands the whole RPC JSON (~4/3x), and the decoder drops lines over 64 MiB
 * (src/core/client/frames.ts MAX_LINE_BYTES). 32 MiB of base64 total → ~43 MiB on the
 * wire, safely under the cap with headroom for text + JSON framing. */
export const MAX_PROMPT_IMAGES = 8;
/** Max decoded bytes per image: matches Flutter's 8 MiB raw cap and covers CLI's
 * ~4.5 MiB resized max. The base64 cap is its exact encoding size (4*ceil(n/3)). */
export const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
/** Max base64 chars per image (8 MiB decoded). */
export const MAX_IMAGE_BASE64_CHARS = 11_184_812;
/** Max total base64 chars across all images (24 MiB decoded). */
export const MAX_PROMPT_IMAGES_TOTAL_BASE64_CHARS = 32 * 1024 * 1024;
/** Max prompt text chars (matches REST queued-prompt limit). */
export const MAX_PROMPT_TEXT_CHARS = 64 * 1024;
export const ALLOWED_PROMPT_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Durable/fan-out descriptor — never the raw base64 (keeps session_events rows small). */
export interface PromptImageDescriptor {
  mimeType: string;
  /** Decoded byte size of the base64 payload. */
  bytes: number;
}

/** Persisted/fanned-out user_prompt payload. `images` is present only when attached. */
export interface UserPromptPayload {
  text: string;
  images?: PromptImageDescriptor[];
}

function decodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - padding;
}

/** Throw (message safe to surface to the client) when images are out of bounds. */
export function validatePromptImages(images: unknown): asserts images is ImageContent[] | null | undefined {
  // Null rides with undefined: pi's own rpc.prompt treats nullish images as absent
  // (it spreads `...(images ? { images } : {})`), so a JSON client sending
  // `"images": null` must not newly fail at the gateway.
  if (images === undefined || images === null) return;
  if (!Array.isArray(images)) throw new Error("prompt images must be an array");
  if (images.length > MAX_PROMPT_IMAGES) {
    throw new Error(`prompt accepts at most ${MAX_PROMPT_IMAGES} images, got ${images.length}`);
  }
  let total = 0;
  for (let i = 0; i < images.length; i++) {
    const img = images[i] as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (typeof img !== "object" || img === null || img.type !== "image") {
      throw new Error(`prompt images[${i}].type must be "image"`);
    }
    if (typeof img.mimeType !== "string" || !ALLOWED_PROMPT_IMAGE_MIMES.has(img.mimeType)) {
      throw new Error(
        `prompt images[${i}].mimeType must be one of ${[...ALLOWED_PROMPT_IMAGE_MIMES].join(", ")}`,
      );
    }
    if (typeof img.data !== "string" || img.data.length === 0) {
      throw new Error(`prompt images[${i}].data must be non-empty base64`);
    }
    if (img.data.length > MAX_IMAGE_BASE64_CHARS) {
      throw new Error(
        `prompt images[${i}] exceeds 8 MiB (${MAX_IMAGE_BASE64_CHARS} base64 chars)`,
      );
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(img.data)) {
      throw new Error(`prompt images[${i}].data is not valid base64`);
    }
    total += img.data.length;
    if (total > MAX_PROMPT_IMAGES_TOTAL_BASE64_CHARS) {
      throw new Error(
        `prompt images exceed 24 MiB total (${MAX_PROMPT_IMAGES_TOTAL_BASE64_CHARS} total base64 chars)`,
      );
    }
  }
}

/** Descriptors for persistence/fan-out (no raw bytes). Call after validatePromptImages. */
export function describePromptImages(images: ImageContent[] | undefined): PromptImageDescriptor[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((img) => ({ mimeType: img.mimeType, bytes: decodedBytes(img.data) }));
}

/** Normalize prompt text: missing/non-string → ""; blank text needs images to carry the turn.
 * The blank check trims (a whitespace-only turn is a blank turn) but the original text is
 * preserved verbatim on success — the gateway never rewrites what the user wrote. */
export function normalizePromptText(text: unknown, imageCount: number): string {
  const normalized = typeof text === "string" ? text : "";
  if (normalized.length > MAX_PROMPT_TEXT_CHARS) {
    throw new Error(`prompt text exceeds ${MAX_PROMPT_TEXT_CHARS} chars`);
  }
  if (normalized.trim() === "" && imageCount === 0) {
    throw new Error("prompt must contain text or at least one image");
  }
  return normalized;
}

/** Single shared ingress for both prompt surfaces (first-class frame and raw rpc
 * passthrough): validate images, normalize text, hand back exactly what the service
 * persists (descriptors) and forwards (full images). One function so the two call sites
 * cannot drift into different bounds. */
export function preparePromptIngress(input: { text?: unknown; images?: unknown }): {
  text: string;
  images: ImageContent[] | undefined;
} {
  validatePromptImages(input.images);
  const images = (input.images ?? undefined) as ImageContent[] | undefined;
  const text = normalizePromptText(input.text, images?.length ?? 0);
  return { text, images };
}

/** Schema-correct rpc_result for gateway-side prompt validation failures. Pi's own error
 * responses always carry `command` (RpcResponse error variant), so the synthetic one must
 * too — full-fidelity clients correlate on it. */
export function promptValidationRpcResult(
  id: string,
  commandType: unknown,
  error: unknown,
): Extract<ServerMessage, { type: "rpc_result" }> {
  return {
    type: "rpc_result",
    id,
    response: {
      type: "response",
      id,
      command: typeof commandType === "string" ? commandType : "prompt",
      success: false,
      error: error instanceof Error ? error.message : "invalid prompt images",
    },
  };
}

export async function deliverUserPrompt(args: {
  text: string;
  images?: ImageContent[];
  persist: (payload: UserPromptPayload) => Promise<PersistedEvent>;
  fanOut: (seq: number, ts: string, payload: UserPromptPayload) => void;
  prompt: () => Promise<void>;
}): Promise<void> {
  const descriptors = describePromptImages(args.images);
  const payload: UserPromptPayload = descriptors
    ? { text: args.text, images: descriptors }
    : { text: args.text };
  const { seq, ts } = await args.persist(payload);
  args.fanOut(seq, ts, payload);
  await args.prompt();
}

export interface WsSink {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export type ServerMessage =
  | {
      type: "hello";
      sessionId: string;
      podId: string;
      latestSeq: number;
      /** First seq the socket will replay, or null when nothing is replayed. */
      firstReplayedSeq: number | null;
      /** Present when the client's from_seq predates history the log still holds. */
      firstAvailableSeq?: number;
      state: unknown;
      /** The pod shim's hello — proto and pi version — so a CLI can run its handshake (account-mode-spec §6.1). */
      shim: ShimHello | null;
      /** Pi this gateway bundles. Clients must not install a newer pi into the pod. */
      serverPiVersion: string;
    }
  | { type: "event"; seq: number; kind: string; payload: unknown; ts: string }
  /** High-rate traffic — remote component frames and streaming message snapshots — is
   * live/cached, never part of durable transcript replay. */
  | { type: "ephemeral"; kind: string; payload: unknown }
  | { type: "replay_gap"; fromSeq: number; toSeq: number }
  /** A blocking extension dialog was answered by some client; others should put it away. */
  | { type: "dialog_closed"; id: string }
  | { type: "pod_state"; state: string; reason?: string }
  /** Durable pod-row change. Emitted only after `pods.name` has been written, so a later GET agrees. */
  | { type: "pod_updated"; id: string; name: string }
  | {
      type: "queued_prompt_status";
      queuedPromptId: string;
      status: "pending" | "delivering" | "delivered" | "failed" | "unknown";
    }
  /** Structured close of this gateway session. Fan-out happens before the socket close so
   *  a live client can keep the transcript and react to the reason instead of guessing. */
  | {
      type: "session_ended";
      reason: string;
      kind: SessionEndKind;
      recoverable: boolean;
    }
  | { type: "pong" }
  | {
      type: "models";
      models: unknown[];
      current: unknown;
      /** Present only on the fresh snapshot emitted after a semantic set. */
      requestId?: string;
      thinkingLevel: ThinkingLevel;
      thinkingLevels: ThinkingLevel[];
    }
  | {
      type: "sessions";
      sessions: import("./session-services.js").SessionCatalogEntry[];
      workdir: string;
      complete: boolean;
      unsupported?: true;
    }
  | { type: "session_hits"; hits: import("./session-services.js").SessionSearchHit[]; unsupported?: true }
  | { type: "resources_reloaded"; ok: boolean; unsupported?: true }
  | {
      type: "files";
      entries: import("./session-services.js").FileListEntry[];
      complete: boolean;
      unsupported?: true;
    }
  | {
      type: "tui_manifest";
      digest?: string;
      unchanged?: true;
      manifest?: Record<string, unknown>;
      unsupported?: true;
    }
  /** Answer to a multiplexed `rpc` command, addressed to the socket that sent it (§6.1). */
  | { type: "rpc_result"; id: string; response: unknown }
  /** Auxiliary LLM completion served pod-side; answered only to the asking sink, never fanned out. */
  | {
      type: "aux_complete_result";
      id: string;
      ok: boolean;
      text?: string;
      stopReason?: string;
      usage?: unknown;
      code?: string;
      error?: string;
    }
  /** Shim control events (pi exit, stderr tail), fanned out live to every client (§6.1). */
  | { type: "control"; payload: unknown }
  | { type: "error"; code: string; message: string; detail?: unknown };

export type ClientMessage =
  | { type: "prompt"; text?: string; images?: ImageContent[] }
  | { type: "interrupt" }
  | {
      type: "set";
      model?: { provider: string; id: string };
      thinkingLevel?: ThinkingLevel;
      /** Client-owned correlation for the post-set semantic models snapshot. */
      requestId?: string;
      command?: Record<string, unknown>;
    }
  | { type: "get_models" }
  | { type: "get_sessions" }
  | { type: "search_sessions"; text: string; limit?: number }
  | { type: "reload_resources" }
  | { type: "get_files"; query: string }
  | { type: "get_tui_manifest"; knownDigest?: string }
  /** Auxiliary LLM completion served pod-side via the prompt tunnel (semantic, sink-only). */
  | {
      type: "aux_complete";
      id: string;
      provider: string;
      model: string;
      systemPrompt?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      thinkingLevel?: ThinkingLevel;
      maxTokens?: number;
      timeoutMs?: number;
    }
  /** Cancel an in-flight auxiliary completion; unknown ids are a silent no-op. */
  | { type: "aux_cancel"; id: string }
  /** Generic RpcCommand passthrough for full-fidelity clients (account-mode-spec §6.1). The
   *  command keeps the client's own request id (unique-prefixed), so id-correlated event
   *  streams — bash output, extension flows — still line up on the client. */
  | { type: "rpc"; id: string; command: Record<string, unknown> }
  /** An extension-UI answer, forwarded to pi; answering a blocking dialog closes it for everyone. */
  | { type: "ui_response"; response: Record<string, unknown> }
  | { type: "ping" };
