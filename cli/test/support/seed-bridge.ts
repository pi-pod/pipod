import {
  SEED_BRIDGE_NOTIFICATION_PREFIX,
  SEED_CONTEXT_COMMAND,
  SEED_TREE_SUMMARY_COMMAND,
} from "../../src/shim/pi-pod-ext.js";
import type { TestRpcClient } from "./test-rpc-client.js";

export const SEED_COMMANDS = [
  { name: SEED_CONTEXT_COMMAND, source: "extension" },
  { name: SEED_TREE_SUMMARY_COMMAND, source: "extension" },
];

export type SeedContextAnswer = {
  entries: unknown[];
  leafId: string | null;
  compactionCount?: number;
  nodes?: Array<Record<string, unknown>>;
};

function decodePrompt(message: string): { id: string; op: string } | null {
  const encoded = message.split(" ")[1];
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { id: string; op: string };
  } catch {
    return null;
  }
}

function notifySeed(channel: TestRpcClient, response: unknown): void {
  channel.injectEvent({
    type: "extension_ui_request",
    id: "ui",
    method: "notify",
    message: SEED_BRIDGE_NOTIFICATION_PREFIX + Buffer.from(JSON.stringify(response), "utf8").toString("base64url"),
  });
}

export function isSeedPrompt(message: string): boolean {
  return message.startsWith(`/${SEED_CONTEXT_COMMAND} `) || message.startsWith(`/${SEED_TREE_SUMMARY_COMMAND} `);
}

export function nodesFromEntries(entries: Array<{ id: string; parentId: string | null; type?: string; timestamp?: string }>): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type ?? "message",
    timestamp: entry.timestamp ?? "",
    preview: entry.id,
    role: "user",
  }));
}

/** Answer every still-pending seed-bridge prompt. Safe to call when none are pending. */
export function answerPendingSeedPrompts(channel: TestRpcClient, answer: SeedContextAnswer): number {
  const prompts = channel.commandsOf("prompt") as Array<{ message: string }>;
  let answered = 0;
  for (const prompt of prompts) {
    if (!isSeedPrompt(prompt.message)) continue;
    const request = decodePrompt(prompt.message);
    if (!request) continue;
    if (request.op === "get-context") {
      notifySeed(channel, {
        v: 1,
        id: request.id,
        op: "get-context",
        ok: true,
        data: {
          entries: answer.entries,
          leafId: answer.leafId,
          compactionCount: answer.compactionCount ?? 0,
        },
      });
      channel.respond("prompt");
      answered += 1;
    } else if (request.op === "get-tree-summary") {
      notifySeed(channel, {
        v: 1,
        id: request.id,
        op: "get-tree-summary",
        ok: true,
        data: {
          leafId: answer.leafId,
          nodes: answer.nodes ?? nodesFromEntries(answer.entries as Array<{ id: string; parentId: string | null }>),
        },
      });
      channel.respond("prompt");
      answered += 1;
    }
  }
  return answered;
}

export async function waitForSeedPrompts(channel: TestRpcClient): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const prompts = channel.commandsOf("prompt") as Array<{ message: string }>;
    const ops = new Set(
      prompts.flatMap((prompt) => {
        if (!isSeedPrompt(prompt.message)) return [];
        const request = decodePrompt(prompt.message);
        return request ? [request.op] : [];
      }),
    );
    if (ops.has("get-context") && ops.has("get-tree-summary")) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for seed bridge prompts");
}
