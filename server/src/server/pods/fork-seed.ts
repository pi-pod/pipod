/**
 * Fetch and persist a source pod's pi session JSONL so a new pod can spawn with `--fork`.
 *
 * Callers supply a sandbox and an optional pod-relative session path. This module hides
 * path validation, newest-file selection, trailing-partial-line trim, the 32 MiB cap,
 * and the seed row lifecycle. The gateway only needs `loadUnconsumedForkSeed` and
 * `consumeForkSeed`.
 */
import type { Queryable } from "../db/index.js";
import { query } from "../db/index.js";
import { badRequest, conflict } from "../httperrors.js";
import { payloadTooLarge } from "../httperrors.js";
import type { Sandbox } from "../../core/providers/types.js";

export const SESSION_STEERING_ARGS = new Set([
  "--continue", "-c", "--resume", "-r", "--session", "--session-id", "--fork", "--no-session",
]);

export function piArgsHaveSessionSteering(args: string[]): boolean {
  return args.some((arg) =>
    [...SESSION_STEERING_ARGS].some(
      (flag) => arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`)),
    ),
  );
}

export const FORK_SEED_MAX_BYTES = 32 * 1024 * 1024;
export const FORK_SEED_STAGING_PATH = "/tmp/pi-pod-fork-seed.jsonl";
export const FORK_SEED_RETENTION = "7 days";

export const SOURCE_SESSION_UNREACHABLE =
  "source pod's session data is unreachable; the pod must be running or restorable";

const SESSIONS_REL = ".pi/agent/sessions";
const LIST_SESSIONS_SCRIPT = `
const fs = require("fs");
const path = require("path");
const root = path.join(process.env.HOME || "/root", ${JSON.stringify(SESSIONS_REL)});
function walk(dir, depth, out) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const st = fs.statSync(full);
        out.push({
          path: path.relative(root, full).split(path.sep).join("/"),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {}
    }
  }
}
const out = [];
walk(root, 0, out);
process.stdout.write(JSON.stringify(out));
`;

export interface ForkFrom {
  podId: string;
  sessionPath?: string;
}

export interface ForkSeed {
  sourcePodId: string;
  sourcePath: string;
  content: Buffer;
}

export interface SessionFileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Same segment rules as the client mirror: boring names only, no traversal. */
export function safeSessionRelPath(rel: string): string | null {
  if (rel.length === 0 || rel.length > 512) return null;
  const segments = rel.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return null;
    if (!/^[A-Za-z0-9._@-]+$/.test(segment)) return null;
  }
  return segments.join("/");
}

/** JSONL is only well-formed at line boundaries; drop a trailing mid-append line. */
export function trimTrailingPartialLine(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  if (buf[buf.length - 1] === 0x0a) return buf;
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return Buffer.alloc(0);
  return buf.subarray(0, lastNl + 1);
}

/** Newest mtime wins; ties prefer the later path so the choice is stable. */
export function pickNewestSessionPath(entries: SessionFileEntry[]): string | null {
  let best: SessionFileEntry | null = null;
  for (const entry of entries) {
    if (!entry.path.endsWith(".jsonl")) continue;
    if (
      !best ||
      entry.mtimeMs > best.mtimeMs ||
      (entry.mtimeMs === best.mtimeMs && entry.path > best.path)
    ) {
      best = entry;
    }
  }
  return best?.path ?? null;
}

export function inheritForkLaunchIdentity<T extends { name: string }>(args: {
  templateId?: string | null;
  project?: T | null;
  source: { template_id: string | null; project: string | null };
  emptyProject: (name: string) => T;
}): { templateId: string | null; project: T | null } {
  if (args.templateId || args.project) {
    return { templateId: args.templateId ?? null, project: args.project ?? null };
  }
  return {
    templateId: args.source.template_id,
    project: args.source.project ? args.emptyProject(args.source.project) : null,
  };
}

export async function readSessionJsonl(
  sandbox: Sandbox,
  sessionPath?: string,
): Promise<{ sourcePath: string; content: Buffer }> {
  if (sessionPath !== undefined && safeSessionRelPath(sessionPath) === null) {
    throw badRequest("sessionPath must be a relative session path with safe path segments");
  }

  const listed = await listSessionFiles(sandbox);
  const sourcePath = sessionPath ?? pickNewestSessionPath(listed);
  if (!sourcePath) throw conflict("source pod has no session to fork");

  const meta = listed.find((entry) => entry.path === sourcePath);
  if (!meta) throw conflict("source pod has no session to fork");
  if (meta.size > FORK_SEED_MAX_BYTES) {
    throw payloadTooLarge(
      `source session is ${meta.size} bytes; forks are capped at ${FORK_SEED_MAX_BYTES} bytes`,
    );
  }

  const raw = await readSessionFile(sandbox, sourcePath);
  if (raw.length > FORK_SEED_MAX_BYTES) {
    throw payloadTooLarge(
      `source session is ${raw.length} bytes; forks are capped at ${FORK_SEED_MAX_BYTES} bytes`,
    );
  }
  const content = trimTrailingPartialLine(raw);
  if (content.length === 0) throw conflict("source pod has no session to fork");
  return { sourcePath, content };
}

export async function insertForkSeed(
  db: Queryable,
  row: { podId: string; sourcePodId: string; sourcePath: string; content: Buffer },
): Promise<void> {
  await db.query(
    `INSERT INTO pod_fork_seeds (pod_id, source_pod_id, source_path, content)
     VALUES ($1, $2, $3, $4)`,
    [row.podId, row.sourcePodId, row.sourcePath, row.content],
  );
}

export async function loadUnconsumedForkSeed(podId: string): Promise<ForkSeed | null> {
  const rows = await query<{ source_pod_id: string; source_path: string; content: Buffer }>(
    `SELECT source_pod_id, source_path, content
       FROM pod_fork_seeds
      WHERE pod_id = $1 AND consumed_at IS NULL`,
    [podId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    sourcePodId: row.source_pod_id,
    sourcePath: row.source_path,
    content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content),
  };
}

export async function consumeForkSeed(podId: string): Promise<void> {
  await query(
    `UPDATE pod_fork_seeds SET consumed_at = now()
      WHERE pod_id = $1 AND consumed_at IS NULL`,
    [podId],
  );
}

export async function deleteForkSeedsForPod(db: Queryable, podId: string): Promise<void> {
  await db.query(`DELETE FROM pod_fork_seeds WHERE pod_id = $1`, [podId]);
}

/** Drop consumed seeds past the short window, and unconsumed seeds whose pod cannot spawn. */
export async function expireForkSeeds(): Promise<{ consumed: number; orphaned: number }> {
  const consumed = await query(
    `DELETE FROM pod_fork_seeds
      WHERE consumed_at IS NOT NULL
        AND consumed_at < now() - $1::interval`,
    [FORK_SEED_RETENTION],
  );
  const orphaned = await query(
    `DELETE FROM pod_fork_seeds s
      WHERE s.consumed_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM pods p
           WHERE p.id = s.pod_id
             AND p.state = 'active'
             AND p.provider_state <> 'gone'
        )`,
  );
  return { consumed: consumed.rowCount ?? 0, orphaned: orphaned.rowCount ?? 0 };
}

async function listSessionFiles(sandbox: Sandbox): Promise<SessionFileEntry[]> {
  const result = await sandbox.exec(["node", "-e", LIST_SESSIONS_SCRIPT], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw conflict(SOURCE_SESSION_UNREACHABLE);
  const raw = result.output?.trim() ?? "";
  if (raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as SessionFileEntry[];
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed.filter(
      (entry) =>
        entry &&
        typeof entry.path === "string" &&
        typeof entry.mtimeMs === "number" &&
        typeof entry.size === "number" &&
        safeSessionRelPath(entry.path) !== null,
    );
  } catch {
    throw conflict(SOURCE_SESSION_UNREACHABLE);
  }
}

async function readSessionFile(sandbox: Sandbox, rel: string): Promise<Buffer> {
  const home = (await sandbox.exec(["printenv", "HOME"], { timeoutMs: 15_000 })).output?.trim() || "/root";
  const fullPath = `${home.replace(/\/$/, "")}/${SESSIONS_REL}/${rel}`;
  const result = await sandbox.exec(["base64", fullPath], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw conflict("source pod has no session to fork");
  try {
    return Buffer.from((result.output ?? "").replace(/\s+/g, ""), "base64");
  } catch {
    throw conflict(SOURCE_SESSION_UNREACHABLE);
  }
}
