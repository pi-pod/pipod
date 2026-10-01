/**
 * Pod-side session catalog + search: standalone JS spliced into the generated
 * extension, mirrored by loadSessionCatalogLogic() so tests cannot drift.
 *
 * The uploaded extension cannot import SessionManager, so this scanner walks
 * PI_CODING_AGENT_DIR or ~/.pi/agent, then sessions/<cwd>/*.jsonl, and parses JSONL
 * itself. Caps below are part of the v1 contract — export them and keep the
 * generated source on the same literals.
 *
 * List (pod:_list-sessions-v1 / pod:_list-sessions-chunked-v1):
 * - SESSION_CATALOG_MAX_SESSIONS most-recently-modified files (500)
 * - SESSION_CATALOG_FIRST_MESSAGE_MAX_CHARS firstMessage truncation (200)
 * - SESSION_CATALOG_MAX_SCAN_BYTES detailed JSONL budget (32 MiB)
 * - SESSION_CATALOG_MAX_SCAN_MS wall-clock budget (~2 s), including discovery
 * - SESSION_CATALOG_MAX_DISCOVERED_FILES candidate-stat cap (10,000)
 * - SESSION_CATALOG_HEADER_SCAN_BYTES per-file header fallback
 *
 * Search (pod:_search-sessions-v1):
 * - SESSION_SEARCH_DEFAULT_LIMIT / SESSION_SEARCH_MAX_LIMIT (20 / 50)
 * - SESSION_SEARCH_MAX_FILES most recent files scanned (200)
 * - SESSION_SEARCH_MAX_SCAN_BYTES / SESSION_SEARCH_MAX_SCAN_MS (32 MiB / 1500 ms)
 * - SESSION_SEARCH_SNIPPET_MAX_CHARS hit snippet truncation (200)
 *
 * Wire entries never include allMessagesText or any other full message body.
 */

/** Most recently modified sessions returned by list. */
export const SESSION_CATALOG_MAX_SESSIONS = 500;
/** `firstMessage` character cap on catalog entries. */
export const SESSION_CATALOG_FIRST_MESSAGE_MAX_CHARS = 200;
/** Shared detailed-parse byte budget for a catalog listing. */
export const SESSION_CATALOG_MAX_SCAN_BYTES = 32 * 1024 * 1024;
/** Shared wall-clock budget for a catalog listing (~2 seconds). */
export const SESSION_CATALOG_MAX_SCAN_MS = 2000;
/** Candidate files statted before sorting by recency; bounds hostile/huge trees. */
export const SESSION_CATALOG_MAX_DISCOVERED_FILES = 10_000;
/** Per-file header-only fallback when the detailed budget is exhausted. */
export const SESSION_CATALOG_HEADER_SCAN_BYTES = 8 * 1024;
/** Default search hit cap when the request omits `limit`. */
export const SESSION_SEARCH_DEFAULT_LIMIT = 20;
/** Hard search hit cap. */
export const SESSION_SEARCH_MAX_LIMIT = 50;
/** Most recently modified session files a search may open. */
export const SESSION_SEARCH_MAX_FILES = 200;
/** Shared detailed-parse byte budget for a search. */
export const SESSION_SEARCH_MAX_SCAN_BYTES = 32 * 1024 * 1024;
/** Wall-clock budget for a search. */
export const SESSION_SEARCH_MAX_SCAN_MS = 1500;
/** Search snippet character cap. */
export const SESSION_SEARCH_SNIPPET_MAX_CHARS = 200;

export type SessionCatalogEntry = {
  id: string;
  createdAt: number;
  cwd?: string;
  parentSessionId?: string;
  name?: string;
  modified?: number;
  messageCount?: number;
  firstMessage?: string;
  path?: string;
};

export type SessionSearchHit = {
  sessionId: string;
  score?: number;
  top?: { entryId?: string; snippet?: string; timestamp: number };
};

export type SessionCatalogData = {
  sessions: SessionCatalogEntry[];
  complete: boolean;
};

export type SessionSearchData = {
  hits: SessionSearchHit[];
};

/** Minimal fs surface used by the spliced scanner; tests pass node:fs. */
export type SessionCatalogFs = typeof import("node:fs");

export type SessionCatalogOptions = {
  env?: Record<string, string | undefined>;
  homedir?: () => string;
  sessionsRoot?: string;
  now?: () => number;
  maxSessions?: number;
  maxScanBytes?: number;
  maxScanMs?: number;
  maxDiscoveredFiles?: number;
  firstMessageMaxChars?: number;
  headerScanBytes?: number;
};

export type SessionSearchOptions = SessionCatalogOptions & {
  text: string;
  limit?: number;
  maxFiles?: number;
  snippetMaxChars?: number;
};

/** Standalone JS spliced into the generated extension. */
export const SESSION_CATALOG_LOGIC = `
function joinCatalogPath(left, right) {
  if (!left) return right || "";
  if (!right) return left;
  return String(left).replace(/[\\\\/]+$/, "") + "/" + String(right).replace(/^[\\\\/]+/, "");
}

function resolveSessionsRoot(options) {
  options = options || {};
  if (typeof options.sessionsRoot === "string" && options.sessionsRoot) return options.sessionsRoot;
  const env = options.env || {};
  const fromEnv = typeof env.PI_CODING_AGENT_DIR === "string" ? env.PI_CODING_AGENT_DIR.trim() : "";
  let agentDir = fromEnv;
  if (!agentDir) {
    const home = typeof options.homedir === "function"
      ? options.homedir()
      : (env.HOME || env.USERPROFILE || "");
    agentDir = joinCatalogPath(home, ".pi/agent");
  }
  return joinCatalogPath(agentDir, "sessions");
}

function catalogNow(options) {
  return typeof options.now === "function" ? options.now() : Date.now();
}

function readBounded(fs, filePath, maxBytes) {
  if (!(maxBytes > 0)) return "";
  if (typeof fs.openSync === "function" && typeof fs.readSync === "function") {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      if (typeof fs.closeSync === "function") fs.closeSync(fd);
    }
  }
  if (typeof fs.readFileSync !== "function") return "";
  const raw = fs.readFileSync(filePath);
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  return buf.subarray(0, Math.min(buf.length, maxBytes)).toString("utf8");
}

function parseJsonLine(line) {
  if (!line || !String(line).trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseHeaderFromText(text) {
  const lines = String(text || "").split(/\\r?\\n/);
  for (const line of lines) {
    const entry = parseJsonLine(line);
    if (!entry) continue;
    if (entry.type === "session" && typeof entry.id === "string" && entry.id) return entry;
    return null;
  }
  return null;
}

function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

function truncateText(text, max) {
  if (typeof text !== "string") return "";
  if (!(max > 0) || text.length <= max) return text;
  return text.slice(0, max);
}

const CATALOG_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CATALOG_UUID_IN_NAME_RE = /(?:^|_)([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

function inferParentSessionId(parentSession, fs, headerScanBytes) {
  if (typeof parentSession !== "string") return undefined;
  const trimmed = parentSession.trim();
  if (!trimmed) return undefined;
  if (CATALOG_UUID_RE.test(trimmed)) return trimmed;
  if (fs && headerScanBytes > 0 && (trimmed.startsWith("/") || /[\\\\/]/.test(trimmed) || trimmed.endsWith(".jsonl"))) {
    try {
      const header = parseHeaderFromText(readBounded(fs, trimmed, headerScanBytes));
      if (header && typeof header.id === "string" && header.id) return header.id;
    } catch {}
  }
  const base = trimmed.replace(/\\\\/g, "/").split("/").pop() || "";
  const withoutExt = base.endsWith(".jsonl") ? base.slice(0, -6) : base;
  if (CATALOG_UUID_RE.test(withoutExt)) return withoutExt;
  const match = withoutExt.match(CATALOG_UUID_IN_NAME_RE);
  if (match) return match[1];
  return undefined;
}

function epochMs(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function collectSessionFilesBounded(fs, sessionsRoot, options) {
  options = options || {};
  const files = [];
  let complete = true;
  const deadline = typeof options.deadline === "number" ? options.deadline : Infinity;
  const maxFiles = typeof options.maxFiles === "number" ? options.maxFiles : Infinity;
  const now = typeof options.now === "function" ? options.now : Date.now;
  let dirents;
  try {
    dirents = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return { files: files, complete: true };
  }
  outer: for (const dirent of dirents) {
    if (files.length >= maxFiles || now() >= deadline) {
      complete = false;
      break;
    }
    const name = typeof dirent === "string" ? dirent : dirent && dirent.name;
    if (typeof name !== "string" || !name) continue;
    const isDir = typeof dirent === "object" && dirent && typeof dirent.isDirectory === "function"
      ? dirent.isDirectory() || (typeof dirent.isSymbolicLink === "function" && dirent.isSymbolicLink())
      : true;
    if (!isDir) continue;
    const dir = joinCatalogPath(sessionsRoot, name);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const fileName of names) {
      if (files.length >= maxFiles || now() >= deadline) {
        complete = false;
        break outer;
      }
      const entryName = typeof fileName === "string" ? fileName : fileName && fileName.name;
      if (typeof entryName !== "string" || !entryName.endsWith(".jsonl")) continue;
      const filePath = joinCatalogPath(dir, entryName);
      try {
        const st = fs.statSync(filePath);
        if (typeof st.isFile === "function" && !st.isFile()) continue;
        const mtimeMs = typeof st.mtimeMs === "number" ? st.mtimeMs : (st.mtime ? +st.mtime : 0);
        const size = typeof st.size === "number" ? st.size : 0;
        files.push({ path: filePath, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0, size });
      } catch {}
    }
  }
  files.sort(function (a, b) {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return { files: files, complete: complete };
}

function collectSessionFiles(fs, sessionsRoot) {
  return collectSessionFilesBounded(fs, sessionsRoot, {}).files;
}

function catalogEntryFromHeader(header, file, fs, headerScanBytes) {
  if (!header || typeof header.id !== "string" || !header.id) return null;
  const createdAt = epochMs(header.timestamp, file.mtimeMs);
  const entry = { id: header.id, createdAt: createdAt };
  if (typeof header.cwd === "string" && header.cwd) entry.cwd = header.cwd;
  const parentSessionId = inferParentSessionId(header.parentSession, fs, headerScanBytes);
  if (parentSessionId) entry.parentSessionId = parentSessionId;
  entry.modified = file.mtimeMs;
  if (file.path) entry.path = file.path;
  return entry;
}

function parseDetailedCatalogEntry(text, file, firstMessageMaxChars, fs, headerScanBytes, completeFile) {
  const lines = String(text || "").split(/\\r?\\n/);
  let header = null;
  let messageCount = 0;
  let firstMessage = "";
  let name;
  let lastActivity = file.mtimeMs;
  for (const line of lines) {
    const parsed = parseJsonLine(line);
    if (!parsed) continue;
    if (!header) {
      if (parsed.type !== "session" || typeof parsed.id !== "string" || !parsed.id) return null;
      header = parsed;
      continue;
    }
    if (parsed.type === "session_info") {
      name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : undefined;
    }
    if (parsed.type !== "message") continue;
    messageCount += 1;
    const message = parsed.message;
    if (!message || typeof message !== "object") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const activity = epochMs(message.timestamp, epochMs(parsed.timestamp, lastActivity));
    if (activity > lastActivity) lastActivity = activity;
    if (!firstMessage && message.role === "user") {
      const body = extractMessageText(message);
      if (body) firstMessage = body;
    }
  }
  const entry = catalogEntryFromHeader(header, file, fs, headerScanBytes);
  if (!entry) return null;
  entry.modified = lastActivity;
  // A prefix scan can find firstMessage safely, but its count/latest name would be a lie.
  if (completeFile) {
    entry.messageCount = messageCount;
    if (name) entry.name = name;
  }
  if (firstMessage) entry.firstMessage = truncateText(firstMessage, firstMessageMaxChars);
  return entry;
}

function readHeaderCatalogEntry(fs, file, headerScanBytes) {
  try {
    const header = parseHeaderFromText(readBounded(fs, file.path, headerScanBytes));
    return catalogEntryFromHeader(header, file, fs, headerScanBytes);
  } catch {
    return null;
  }
}

function buildSessionCatalog(fs, options) {
  options = options || {};
  const maxSessions = options.maxSessions ?? (typeof SESSION_CATALOG_MAX_SESSIONS === "number" ? SESSION_CATALOG_MAX_SESSIONS : ${SESSION_CATALOG_MAX_SESSIONS});
  const maxScanBytes = options.maxScanBytes ?? (typeof SESSION_CATALOG_MAX_SCAN_BYTES === "number" ? SESSION_CATALOG_MAX_SCAN_BYTES : ${SESSION_CATALOG_MAX_SCAN_BYTES});
  const maxScanMs = options.maxScanMs ?? (typeof SESSION_CATALOG_MAX_SCAN_MS === "number" ? SESSION_CATALOG_MAX_SCAN_MS : ${SESSION_CATALOG_MAX_SCAN_MS});
  const firstMessageMaxChars = options.firstMessageMaxChars ?? (typeof SESSION_CATALOG_FIRST_MESSAGE_MAX_CHARS === "number" ? SESSION_CATALOG_FIRST_MESSAGE_MAX_CHARS : ${SESSION_CATALOG_FIRST_MESSAGE_MAX_CHARS});
  const headerScanBytes = options.headerScanBytes ?? (typeof SESSION_CATALOG_HEADER_SCAN_BYTES === "number" ? SESSION_CATALOG_HEADER_SCAN_BYTES : ${SESSION_CATALOG_HEADER_SCAN_BYTES});
  const maxDiscoveredFiles = options.maxDiscoveredFiles ?? (typeof SESSION_CATALOG_MAX_DISCOVERED_FILES === "number" ? SESSION_CATALOG_MAX_DISCOVERED_FILES : ${SESSION_CATALOG_MAX_DISCOVERED_FILES});
  const started = catalogNow(options);
  const discovered = collectSessionFilesBounded(fs, resolveSessionsRoot(options), {
    deadline: started + maxScanMs,
    maxFiles: maxDiscoveredFiles,
    now: function () { return catalogNow(options); },
  });
  const files = discovered.files;
  let complete = discovered.complete;
  const selected = files.length > maxSessions ? files.slice(0, maxSessions) : files;
  if (selected.length !== files.length) complete = false;
  let bytesLeft = maxScanBytes;
  const sessions = [];
  for (const file of selected) {
    const timedOut = catalogNow(options) - started >= maxScanMs;
    if (!timedOut && bytesLeft > 0) {
      const readBytes = Math.min(file.size > 0 ? file.size : bytesLeft, bytesLeft);
      if (readBytes > 0) {
        try {
          const text = readBounded(fs, file.path, readBytes);
          bytesLeft -= Buffer.byteLength(text, "utf8");
          const detailed = parseDetailedCatalogEntry(
            text,
            file,
            firstMessageMaxChars,
            fs,
            headerScanBytes,
            file.size > 0 && readBytes >= file.size,
          );
          if (detailed) {
            sessions.push(detailed);
            continue;
          }
        } catch {}
      }
    }
    const headerOnly = readHeaderCatalogEntry(fs, file, headerScanBytes);
    if (headerOnly) sessions.push(headerOnly);
    else complete = false;
  }
  return { sessions: sessions, complete: complete };
}

function countNeedle(haystackLower, needleLower) {
  if (!needleLower) return 0;
  let count = 0;
  let from = 0;
  const step = Math.max(needleLower.length, 1);
  while (from < haystackLower.length) {
    const idx = haystackLower.indexOf(needleLower, from);
    if (idx < 0) break;
    count += 1;
    from = idx + step;
  }
  return count;
}

function searchSessionFile(text, needleLower, snippetMaxChars) {
  const lines = String(text || "").split(/\\r?\\n/);
  let header = null;
  let score = 0;
  let top = null;
  for (const line of lines) {
    const parsed = parseJsonLine(line);
    if (!parsed) continue;
    if (!header) {
      if (parsed.type !== "session" || typeof parsed.id !== "string" || !parsed.id) return null;
      header = parsed;
      continue;
    }
    if (parsed.type !== "message" || !parsed.message || typeof parsed.message !== "object") continue;
    const role = parsed.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const body = extractMessageText(parsed.message);
    if (!body) continue;
    const lower = body.toLowerCase();
    const idx = lower.indexOf(needleLower);
    if (idx < 0) continue;
    score += countNeedle(lower, needleLower);
    if (!top) {
      const timestamp = epochMs(parsed.message.timestamp, epochMs(parsed.timestamp, epochMs(header.timestamp, 0)));
      top = { snippet: truncateText(body.slice(idx), snippetMaxChars), timestamp: timestamp };
      if (typeof parsed.id === "string" && parsed.id) top.entryId = parsed.id;
    }
  }
  if (!header || !top || score <= 0) return null;
  const hit = { sessionId: header.id, score: score, top: { timestamp: top.timestamp } };
  if (top.entryId) hit.top.entryId = top.entryId;
  if (top.snippet) hit.top.snippet = top.snippet;
  return hit;
}

function resolveSearchLimit(limit) {
  const fallback = typeof SESSION_SEARCH_DEFAULT_LIMIT === "number" ? SESSION_SEARCH_DEFAULT_LIMIT : ${SESSION_SEARCH_DEFAULT_LIMIT};
  const hardMax = typeof SESSION_SEARCH_MAX_LIMIT === "number" ? SESSION_SEARCH_MAX_LIMIT : ${SESSION_SEARCH_MAX_LIMIT};
  if (limit == null) return fallback;
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return 1;
  return n > hardMax ? hardMax : n;
}

function searchSessions(fs, options) {
  options = options || {};
  const text = typeof options.text === "string" ? options.text : "";
  if (!text) return { hits: [] };
  const needleLower = text.toLowerCase();
  const limit = resolveSearchLimit(options.limit);
  const maxFiles = options.maxFiles ?? (typeof SESSION_SEARCH_MAX_FILES === "number" ? SESSION_SEARCH_MAX_FILES : ${SESSION_SEARCH_MAX_FILES});
  const maxScanBytes = options.maxScanBytes ?? (typeof SESSION_SEARCH_MAX_SCAN_BYTES === "number" ? SESSION_SEARCH_MAX_SCAN_BYTES : ${SESSION_SEARCH_MAX_SCAN_BYTES});
  const maxScanMs = options.maxScanMs ?? (typeof SESSION_SEARCH_MAX_SCAN_MS === "number" ? SESSION_SEARCH_MAX_SCAN_MS : ${SESSION_SEARCH_MAX_SCAN_MS});
  const snippetMaxChars = options.snippetMaxChars ?? (typeof SESSION_SEARCH_SNIPPET_MAX_CHARS === "number" ? SESSION_SEARCH_SNIPPET_MAX_CHARS : ${SESSION_SEARCH_SNIPPET_MAX_CHARS});
  const maxDiscoveredFiles = options.maxDiscoveredFiles ?? (typeof SESSION_CATALOG_MAX_DISCOVERED_FILES === "number" ? SESSION_CATALOG_MAX_DISCOVERED_FILES : ${SESSION_CATALOG_MAX_DISCOVERED_FILES});
  const started = catalogNow(options);
  const files = collectSessionFilesBounded(fs, resolveSessionsRoot(options), {
    deadline: started + maxScanMs,
    maxFiles: maxDiscoveredFiles,
    now: function () { return catalogNow(options); },
  }).files.slice(0, maxFiles);
  let bytesLeft = maxScanBytes;
  const hits = [];
  for (const file of files) {
    if (catalogNow(options) - started >= maxScanMs) break;
    if (bytesLeft <= 0) break;
    const readBytes = Math.min(file.size > 0 ? file.size : bytesLeft, bytesLeft);
    if (readBytes <= 0) break;
    try {
      const content = readBounded(fs, file.path, readBytes);
      bytesLeft -= Buffer.byteLength(content, "utf8");
      const hit = searchSessionFile(content, needleLower, snippetMaxChars);
      if (hit) hits.push(hit);
    } catch {}
  }
  hits.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  return { hits: hits.slice(0, limit) };
}
`;

export function loadSessionCatalogLogic(): {
  resolveSessionsRoot: (options?: SessionCatalogOptions) => string;
  collectSessionFiles: (
    fs: SessionCatalogFs,
    sessionsRoot: string,
  ) => Array<{ path: string; mtimeMs: number; size: number }>;
  buildSessionCatalog: (fs: SessionCatalogFs, options?: SessionCatalogOptions) => SessionCatalogData;
  searchSessions: (fs: SessionCatalogFs, options: SessionSearchOptions) => SessionSearchData;
  extractMessageText: (message: unknown) => string;
  inferParentSessionId: (parentSession: unknown, fs?: SessionCatalogFs, headerScanBytes?: number) => string | undefined;
  truncateText: (text: string, max: number) => string;
} {
  return new Function(
    `${SESSION_CATALOG_LOGIC}; return { resolveSessionsRoot, collectSessionFiles, buildSessionCatalog, searchSessions, extractMessageText, inferParentSessionId, truncateText };`,
  )() as ReturnType<typeof loadSessionCatalogLogic>;
}
