/**
 * Pod-side seed payloads: the active context branch plus a flat tree summary.
 *
 * The uploaded extension cannot import launcher modules, so the functions below
 * are authored as standalone JavaScript and spliced into the generated file.
 * Tests eval the same source so the pod and the suite cannot drift.
 */

export const SEED_PREVIEW_MAX_CHARS = 2000;

export type SeedContextData = {
  entries: unknown[];
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

export type SeedSessionManager = {
  buildContextEntries: () => unknown[];
  getEntries: () => unknown[];
  getLeafId: () => string | null | undefined;
  getLabel: (id: string) => string | undefined;
};

/** Standalone JS spliced into the generated extension. */
export const SEED_BRIDGE_LOGIC = `
function previewForEntry(entry) {
  const max = ${SEED_PREVIEW_MAX_CHARS};
  const normalize = (value) => String(value || "").replace(/[\\n\\t\\r]/g, " ").trim();
  const extract = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    let text = "";
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text") text += block.text || "";
    }
    return text;
  };
  if (!entry || typeof entry !== "object") return "";
  let text = "";
  switch (entry.type) {
    case "message": {
      const msg = entry.message || {};
      if (msg.role === "bashExecution") text = msg.command || "";
      else if (msg.role === "toolResult") text = msg.toolName ? "[" + msg.toolName + "]" : "[tool]";
      else text = extract(msg.content);
      if (!text && msg.role === "assistant") text = msg.errorMessage || "";
      break;
    }
    case "custom_message":
      text = typeof entry.content === "string" ? entry.content : extract(entry.content);
      break;
    case "compaction":
    case "branch_summary":
      text = entry.summary || "";
      break;
    case "session_info":
      text = entry.name || "";
      break;
    case "model_change":
      text = entry.modelId || "";
      break;
    case "thinking_level_change":
      text = entry.thinkingLevel || "";
      break;
    case "custom":
      text = entry.customType || "";
      break;
    case "label":
      text = entry.label || "";
      break;
  }
  return normalize(text).slice(0, max);
}

function buildContextData(sessionManager) {
  const entries = sessionManager.getEntries() || [];
  let compactionCount = 0;
  for (const entry of entries) {
    if (entry && entry.type === "compaction") compactionCount += 1;
  }
  return {
    entries: sessionManager.buildContextEntries() || [],
    leafId: sessionManager.getLeafId() ?? null,
    compactionCount: compactionCount,
  };
}

function buildTreeSummaryData(sessionManager) {
  const entries = sessionManager.getEntries() || [];
  const labelTimestamps = new Map();
  for (const entry of entries) {
    if (!entry || entry.type !== "label") continue;
    if (entry.label) labelTimestamps.set(entry.targetId, entry.timestamp);
    else labelTimestamps.delete(entry.targetId);
  }
  const nodes = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string") continue;
    const node = {
      id: entry.id,
      parentId: entry.parentId ?? null,
      type: typeof entry.type === "string" ? entry.type : "custom",
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      preview: previewForEntry(entry),
    };
    if (entry.type === "message") node.role = entry.message && typeof entry.message.role === "string" ? entry.message.role : null;
    if (entry.type === "custom" || entry.type === "custom_message") {
      if (typeof entry.customType === "string") node.customType = entry.customType;
    }
    if (entry.type === "compaction" && typeof entry.tokensBefore === "number") node.tokensBefore = entry.tokensBefore;
    if (entry.type === "model_change" && typeof entry.modelId === "string") node.modelId = entry.modelId;
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") node.thinkingLevel = entry.thinkingLevel;
    if (entry.type === "session_info" && typeof entry.name === "string") node.name = entry.name;
    if (entry.type === "message" && entry.message && entry.message.role === "toolResult" && typeof entry.message.toolName === "string") {
      node.toolName = entry.message.toolName;
    }
    const label = typeof sessionManager.getLabel === "function" ? sessionManager.getLabel(entry.id) : undefined;
    if (typeof label === "string" && label.length > 0) {
      node.label = label;
      const timestamp = labelTimestamps.get(entry.id);
      if (typeof timestamp === "string") node.labelTimestamp = timestamp;
    }
    nodes.push(node);
  }
  return {
    leafId: sessionManager.getLeafId() ?? null,
    nodes: nodes,
  };
}

function encodeSeedChunkNotifications(envelope, gzip, limits = {}) {
  const prefix = limits.notificationPrefix ?? (
    typeof SEED_CHUNK_NOTIFICATION_PREFIX === "string"
      ? SEED_CHUNK_NOTIFICATION_PREFIX
      : ${JSON.stringify("pi-pod-internal/seed-chunk-v1:")}
  );
  const maxPartChars = limits.maxPartChars ?? (
    typeof SEED_CHUNK_MAX_PART_CHARS === "number" ? SEED_CHUNK_MAX_PART_CHARS : ${200_000}
  );
  const maxChunks = limits.maxChunks ?? (
    typeof SEED_CHUNK_MAX_CHUNKS === "number" ? SEED_CHUNK_MAX_CHUNKS : ${4096}
  );
  const maxJsonBytes = limits.maxJsonBytes ?? (
    typeof SEED_CHUNK_MAX_JSON_BYTES === "number" ? SEED_CHUNK_MAX_JSON_BYTES : ${64 * 1024 * 1024}
  );
  const maxEncodedResponseBytes = limits.maxEncodedResponseBytes ?? (
    typeof MAX_SEED_RESPONSE_BYTES === "number" ? MAX_SEED_RESPONSE_BYTES : ${32 * 1024 * 1024}
  );
  const tooLarge = () => ({
    v: 1,
    id: envelope.id,
    op: envelope.op,
    ok: false,
    error: { code: "response_too_large", message: "seed bridge response exceeded the configured limit" },
  });

  let json = JSON.stringify(envelope);
  if (Buffer.byteLength(json, "utf8") > maxJsonBytes) json = JSON.stringify(tooLarge());

  let enc = "gz";
  let bytes;
  try {
    bytes = Buffer.from(gzip(Buffer.from(json, "utf8")));
  } catch {
    enc = "raw";
    bytes = Buffer.from(json, "utf8");
  }

  let payload = bytes.toString("base64url");
  if (payload.length > maxEncodedResponseBytes || Math.ceil(payload.length / maxPartChars) > maxChunks) {
    enc = "raw";
    json = JSON.stringify(tooLarge());
    payload = Buffer.from(json, "utf8").toString("base64url");
  }

  const total = Math.ceil(payload.length / maxPartChars);
  const notifications = [];
  for (let offset = 0, seq = 1; offset < payload.length; offset += maxPartChars, seq += 1) {
    const part = payload.slice(offset, offset + maxPartChars);
    notifications.push(prefix + envelope.id + " " + seq + " " + total + " " + enc + " " + part);
  }
  return notifications;
}
`;

export type SeedEnvelope = {
  v: 1;
  id: string;
  op: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

export type SeedChunkLimits = {
  notificationPrefix?: string;
  maxPartChars?: number;
  maxChunks?: number;
  maxJsonBytes?: number;
  maxEncodedResponseBytes?: number;
};

export function loadSeedBridgeLogic(): {
  previewForEntry: (entry: unknown) => string;
  buildContextData: (sessionManager: SeedSessionManager) => SeedContextData;
  buildTreeSummaryData: (sessionManager: SeedSessionManager) => SeedTreeSummaryData;
  encodeSeedChunkNotifications: (
    envelope: SeedEnvelope,
    gzip: (bytes: Uint8Array) => Uint8Array,
    limits?: SeedChunkLimits,
  ) => string[];
} {
  return new Function(
    `${SEED_BRIDGE_LOGIC}; return { previewForEntry, buildContextData, buildTreeSummaryData, encodeSeedChunkNotifications };`,
  )() as ReturnType<typeof loadSeedBridgeLogic>;
}
