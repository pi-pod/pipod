import type { RpcClientBase } from "../../core/client/rpc.js";

export const SESSION_CATALOG_MAX_ENTRIES = 500;
export const SESSION_TEXT_PREVIEW_MAX_CHARS = 200;
export const SESSION_SEARCH_DEFAULT_LIMIT = 20;
export const SESSION_SEARCH_MAX_LIMIT = 50;

export interface SessionCatalogEntry {
  id: string;
  createdAt: number;
  cwd?: string;
  parentSessionId?: string;
  name?: string;
  modified?: number;
  messageCount?: number;
  firstMessage?: string;
  path?: string;
}

export interface SessionSearchHit {
  sessionId: string;
  score?: number;
  top?: { entryId?: string; snippet?: string; timestamp: number };
}

export type PodCommandServiceRequest =
  | { type: "get_sessions" }
  | { type: "search_sessions"; text: string; limit?: number }
  | { type: "reload_resources" }
  | { type: "get_files"; query: string }
  | { type: "get_tui_manifest"; knownDigest?: string };

/** Mirrors the pod-side result cap; a longer list is a pod not honouring the v1 contract. */
export const FILE_LIST_MAX_ENTRIES = 50;
/** Long enough for any real path, short enough that one cannot flood a client's editor. */
export const FILE_LIST_MAX_PATH_LENGTH = 1024;
/** Matches the pod's own query cap, so an over-long query is refused before it is sent. */
export const FILE_LIST_MAX_QUERY_LENGTH = 512;

/** Defensive ceiling on what a pod-authored manifest may put on a client socket. */
export const TUI_MANIFEST_MAX_BYTES = 512 * 1024;

export type PodCommandServiceFrame =
  | {
      type: "sessions";
      sessions: SessionCatalogEntry[];
      workdir: string;
      complete: boolean;
      unsupported?: true;
    }
  | { type: "session_hits"; hits: SessionSearchHit[]; unsupported?: true }
  | { type: "resources_reloaded"; ok: boolean; unsupported?: true }
  | { type: "files"; entries: FileListEntry[]; complete: boolean; unsupported?: true }
  | {
      type: "tui_manifest";
      digest?: string;
      unchanged?: true;
      manifest?: Record<string, unknown>;
      unsupported?: true;
    };

export interface FileListEntry {
  path: string;
  dir: boolean;
}

export interface PodSessionService {
  list(rpc: RpcClientBase): Promise<{ sessions: unknown[]; complete: boolean }>;
  search(rpc: RpcClientBase, query: { text: string; limit: number }): Promise<unknown[]>;
  listFiles(rpc: RpcClientBase, query: string): Promise<{ entries: unknown[]; complete: boolean }>;
}

/**
 * Defense in depth at the trust boundary: the pod's agent can write these paths, and a
 * client pastes them straight into its editor. Keep the frozen wire fields, drop anything
 * that could rewrite the line it lands in, and cap the list.
 */
export function mapFileListEntries(values: unknown[]): FileListEntry[] {
  const entries: FileListEntry[] = [];
  for (const value of values.slice(0, FILE_LIST_MAX_ENTRIES)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    const filePath = candidate["path"];
    if (typeof filePath !== "string" || filePath.length === 0) continue;
    if (filePath.length > FILE_LIST_MAX_PATH_LENGTH) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(filePath)) continue;
    entries.push({ path: filePath, dir: candidate["dir"] === true });
  }
  return entries;
}

export interface PodCommandServiceDeps {
  rpc: RpcClientBase;
  workdir: string;
  send(frame: PodCommandServiceFrame): void;
  service: PodSessionService;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Defense-in-depth at the trust boundary: keep only the frozen wire fields and caps. */
export function mapSessionCatalogEntries(values: unknown[]): SessionCatalogEntry[] {
  const entries: SessionCatalogEntry[] = [];
  for (const value of values) {
    if (entries.length >= SESSION_CATALOG_MAX_ENTRIES) break;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    const id = optionalString(candidate["id"]);
    const createdAt = optionalFiniteNumber(candidate["createdAt"]);
    if (!id || createdAt === undefined) continue;
    const entry: SessionCatalogEntry = { id, createdAt };
    const cwd = optionalString(candidate["cwd"]);
    const parentSessionId = optionalString(candidate["parentSessionId"]);
    const name = optionalString(candidate["name"]);
    const modified = optionalFiniteNumber(candidate["modified"]);
    const messageCount = optionalFiniteNumber(candidate["messageCount"]);
    const firstMessage = optionalString(candidate["firstMessage"]);
    const path = optionalString(candidate["path"]);
    if (cwd) entry.cwd = cwd;
    if (parentSessionId) entry.parentSessionId = parentSessionId;
    if (name) entry.name = name;
    if (modified !== undefined) entry.modified = modified;
    if (messageCount !== undefined && Number.isInteger(messageCount) && messageCount >= 0) {
      entry.messageCount = messageCount;
    }
    if (firstMessage) entry.firstMessage = firstMessage.slice(0, SESSION_TEXT_PREVIEW_MAX_CHARS);
    if (path) entry.path = path;
    entries.push(entry);
  }
  return entries;
}

export function mapSessionSearchHits(values: unknown[], limit: number): SessionSearchHit[] {
  const hits: SessionSearchHit[] = [];
  for (const value of values) {
    if (hits.length >= limit) break;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    const sessionId = optionalString(candidate["sessionId"]);
    if (!sessionId) continue;
    const hit: SessionSearchHit = { sessionId };
    const score = optionalFiniteNumber(candidate["score"]);
    if (score !== undefined) hit.score = score;
    const top = candidate["top"];
    if (typeof top === "object" && top !== null && !Array.isArray(top)) {
      const topCandidate = top as Record<string, unknown>;
      const timestamp = optionalFiniteNumber(topCandidate["timestamp"]);
      if (timestamp !== undefined) {
        const mappedTop: NonNullable<SessionSearchHit["top"]> = { timestamp };
        const entryId = optionalString(topCandidate["entryId"]);
        const snippet = optionalString(topCandidate["snippet"]);
        if (entryId) mappedTop.entryId = entryId;
        if (snippet) mappedTop.snippet = snippet.slice(0, SESSION_TEXT_PREVIEW_MAX_CHARS);
        hit.top = mappedTop;
      }
    }
    hits.push(hit);
  }
  return hits;
}

export function normalizeSessionSearchLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return SESSION_SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SESSION_SEARCH_MAX_LIMIT, Math.floor(limit)));
}

/**
 * Handle semantic pod-command services without letting extension skew leak into the socket's
 * generic error channel. Every operation failure is an explicit unsupported capability frame.
 */
export async function handlePodCommandService(
  message: PodCommandServiceRequest,
  deps: PodCommandServiceDeps,
): Promise<void> {
  switch (message.type) {
    case "get_sessions":
      try {
        const result = await deps.service.list(deps.rpc);
        const sessions = mapSessionCatalogEntries(result.sessions);
        deps.send({
          type: "sessions",
          sessions,
          workdir: deps.workdir,
          complete:
            result.complete &&
            result.sessions.length <= SESSION_CATALOG_MAX_ENTRIES &&
            sessions.length === result.sessions.length,
        });
      } catch {
        deps.send({
          type: "sessions",
          sessions: [],
          workdir: deps.workdir,
          complete: false,
          unsupported: true,
        });
      }
      return;
    case "search_sessions":
      try {
        if (typeof message.text !== "string") throw new Error("invalid search");
        const limit = normalizeSessionSearchLimit(message.limit);
        const result = await deps.service.search(deps.rpc, { text: message.text, limit });
        deps.send({ type: "session_hits", hits: mapSessionSearchHits(result, limit) });
      } catch {
        deps.send({ type: "session_hits", hits: [], unsupported: true });
      }
      return;
    case "get_files":
      try {
        if (typeof message.query !== "string" || message.query.length > FILE_LIST_MAX_QUERY_LENGTH) {
          throw new Error("invalid file list query");
        }
        const result = await deps.service.listFiles(deps.rpc, message.query);
        deps.send({ type: "files", entries: mapFileListEntries(result.entries), complete: result.complete });
      } catch {
        // An old pod, a timeout, or a malformed reply are all the same to the client: it
        // shows no suggestions rather than completing against its own disk.
        deps.send({ type: "files", entries: [], complete: false, unsupported: true });
      }
      return;
    case "reload_resources":
      // Pi 0.84 exposes no clean extension/runtime resource reload action. Stay honest until it does.
      deps.send({ type: "resources_reloaded", ok: false, unsupported: true });
      return;
    case "get_tui_manifest":
      try {
        const knownDigest =
          typeof message.knownDigest === "string" && message.knownDigest.length <= 64
            ? message.knownDigest
            : undefined;
        const reply = await deps.rpc.requestTuiManifest(knownDigest);
        if (!reply || reply.error !== undefined || reply.v !== 1) {
          deps.send({ type: "tui_manifest", unsupported: true });
          return;
        }
        if (reply.unchanged === true) {
          deps.send({ type: "tui_manifest", digest: reply.digest, unchanged: true });
          return;
        }
        if (
          !reply.manifest ||
          Buffer.byteLength(JSON.stringify(reply.manifest), "utf8") > TUI_MANIFEST_MAX_BYTES
        ) {
          deps.send({ type: "tui_manifest", unsupported: true });
          return;
        }
        deps.send({ type: "tui_manifest", digest: reply.digest, manifest: reply.manifest });
      } catch {
        deps.send({ type: "tui_manifest", unsupported: true });
      }
  }
}
