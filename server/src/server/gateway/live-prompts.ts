import { setTimeout as delay } from "node:timers/promises";
import type { RemoteRpcClient } from "../../core/client/rpc.js";
import { MAX_PROMPT_IMAGES_TOTAL_BASE64_CHARS, MAX_PROMPT_TEXT_CHARS, type preparePromptIngress } from "./stream-fanout.js";

export const LIVE_PROMPT_ADMISSION_MS = 5 * 60_000;
const POLL_MS = 750;
const MAX_PENDING = 16;
const MAX_PENDING_BYTES = (MAX_PROMPT_IMAGES_TOTAL_BASE64_CHARS + MAX_PROMPT_TEXT_CHARS) * 2;
const COMPACTION_REFUSAL = "Cannot submit a prompt while compaction is in progress.";

export class LivePromptRefused extends Error {}

/** Serialize admissions, not agent turns. Keep compaction waits on the gateway (not the
 * phone), bounded by session lifetime and payload budget. Nothing here replays a write
 * whose outcome is unknown. */
export class LivePromptQueue {
  private tail = Promise.resolve();
  private pending = 0;
  private bytes = 0;

  async enqueue<T>(bytes: number, run: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_PENDING || this.bytes + bytes > MAX_PENDING_BYTES) {
      throw new LivePromptRefused("Too many messages are waiting to send. Try again in a moment.");
    }
    this.pending++;
    this.bytes += bytes;
    const result = this.tail.then(run);
    this.tail = result.then(() => {}, () => {});
    try {
      return await result;
    } finally {
      this.pending--;
      this.bytes -= bytes;
    }
  }
}

export async function admitLivePrompt(args: {
  rpc: RemoteRpcClient;
  ingress: ReturnType<typeof preparePromptIngress>;
  behavior: "steer" | "followUp";
  deadline: number;
  isCurrent: () => boolean;
  // Checks the host sleep/admission fence and grants a work lease immediately before dispatch.
  protectDispatch: () => Promise<void>;
  recordAcceptance: () => Promise<void>;
}): Promise<void> {
  const { rpc, ingress, behavior, deadline, isCurrent } = args;
  const assertCanDispatch = () => {
    if (!isCurrent()) throw new LivePromptRefused("The pod session changed before the message could be sent.");
    if (Date.now() >= deadline) throw new LivePromptRefused("The message was not sent because the pod stayed busy too long.");
  };
  assertCanDispatch();
  const original = await rpc.getState();
  let compacting = original.isCompacting;
  for (;;) {
    while (compacting) {
      assertCanDispatch();
      await delay(POLL_MS);
      assertCanDispatch();
      const state = await rpc.getState();
      if (state.sessionId !== original.sessionId || state.sessionFile !== original.sessionFile) {
        throw new LivePromptRefused("The conversation changed while the message was waiting.");
      }
      compacting = state.isCompacting;
    }
    assertCanDispatch();
    await args.protectDispatch();
    assertCanDispatch();
    // Use prompt, not the lower-level steer/follow_up RPCs: if the last turn just
    // ended, Pi starts a normal turn. Pi owns both queues and their batching settings.
    let acceptance: Promise<void> | undefined;
    const response = await rpc.request({
      type: "prompt",
      message: ingress.text,
      ...(ingress.images ? { images: ingress.images as never } : {}),
      streamingBehavior: behavior,
    }, {
      timeoutMs: Math.max(1, deadline - Date.now()),
      // Pi announces acceptance before assistant events, which can arrive in the
      // same chunk. Reserve the transcript position at that wire boundary.
      onResponse: (reply) => { if (reply.success) acceptance = args.recordAcceptance(); },
    });
    if (response.success) {
      await acceptance;
      return;
    }
    if (!response.error.startsWith(COMPACTION_REFUSAL)) throw new LivePromptRefused(response.error);

    // This pinned preflight refusal is before input hooks or agent admission. Wait
    // for Pi itself rather than assuming a compaction_end event means it is ready.
    compacting = true;
  }
}
